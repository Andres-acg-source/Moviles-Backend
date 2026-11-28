import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { db } from '../src/db.js';
import { client, createUser, setupTestDb, startServer } from './helpers.js';

let cleanup: () => Promise<void>;
let server: Awaited<ReturnType<typeof startServer>>;
let api: ReturnType<typeof client>;

before(async () => {
  ({ cleanup } = await setupTestDb());
  server = await startServer();
  api = client(server.base);
});
after(async () => { await server.close(); await cleanup(); });
beforeEach(async () => { await db().query('DELETE FROM spot_reports'); });

const jpeg = (size = 64) => {
  const bytes = Buffer.alloc(size, 0x11);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
};

const report = (overrides: Record<string, unknown> = {}) => ({
  clientId: randomUUID(),
  spotId: 'P2-A-14',
  kind: 'occupied',
  shownStatus: 'free',
  note: 'A car without a reservation since 8:10',
  photo: jpeg().toString('base64'),
  ...overrides
});

test('a report keeps the spot, its level and the state the app showed', async () => {
  const driver = await createUser();
  const reportedAt = new Date(Date.now() - 60_000).toISOString();
  const body = report({ reportedAt });

  const response = await api('POST', '/api/v1/reports', { token: driver.token, body });

  assert.equal(response.status, 201);
  assert.deepEqual(Object.keys(response.body).sort(), [
    'clientId', 'id', 'kind', 'levelCode', 'note', 'photoUrl', 'reportedAt', 'shownStatus', 'spotCode', 'spotId'
  ]);
  assert.equal(response.body.clientId, body.clientId);
  assert.equal(response.body.levelCode, 'P2');
  assert.equal(response.body.spotCode, 'A-14');
  assert.equal(response.body.shownStatus, 'free');
  assert.equal(response.body.reportedAt, reportedAt);
  assert.equal(response.body.photoUrl, `/api/v1/reports/${response.body.id}/photo`);
  const { rows } = await db().query('SELECT user_id, length(photo) AS photo_bytes FROM spot_reports');
  assert.deepEqual(rows, [{ user_id: driver.id, photo_bytes: 64 }]);
});

test('the same report sent twice after losing the signal is saved once', async () => {
  const driver = await createUser();
  const body = report();

  const first = await api('POST', '/api/v1/reports', { token: driver.token, body });
  const again = await api('POST', '/api/v1/reports', { token: driver.token, body });

  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  assert.equal((await db().query('SELECT 1 FROM spot_reports')).rowCount, 1);
});

test('my reports lists only the reports of the driver, newest first', async () => {
  const driver = await createUser();
  const other = await createUser();
  const now = Date.now();
  await api('POST', '/api/v1/reports', { token: driver.token, body: report({ spotId: 'P1-A-01', reportedAt: new Date(now - 3_600_000).toISOString(), photo: undefined, note: '  ' }) });
  await api('POST', '/api/v1/reports', { token: driver.token, body: report({ spotId: 'P3-B-02', kind: 'blocked', reportedAt: new Date(now + 3_600_000).toISOString() }) });
  await api('POST', '/api/v1/reports', { token: driver.token, body: report({ spotId: 'P2-A-03', reportedAt: new Date(now - 30 * 86_400_000).toISOString() }) });
  await api('POST', '/api/v1/reports', { token: other.token, body: report() });

  const response = await api('GET', '/api/v1/reports/mine', { token: driver.token });

  assert.equal(response.status, 200);
  const reports = response.body.reports;
  assert.deepEqual(reports.map((item: { spotId: string }) => item.spotId), ['P3-B-02', 'P1-A-01', 'P2-A-03']);
  assert.ok(Date.parse(reports[0].reportedAt) <= Date.now(), 'a time in the future is moved to now');
  assert.ok(Date.parse(reports[2].reportedAt) >= now - 7 * 86_400_000 - 60_000, 'a very old time is moved to 7 days ago');
  assert.equal(reports[1].photoUrl, null);
  assert.equal(reports[1].note, null);
});

test('the photo of a report is only served to the driver who sent it', async () => {
  const driver = await createUser();
  const other = await createUser();
  const photo = jpeg(2048);
  const sent = await api('POST', '/api/v1/reports', { token: driver.token, body: report({ photo: photo.toString('base64') }) });
  const withoutPhoto = await api('POST', '/api/v1/reports', { token: driver.token, body: report({ photo: undefined }) });
  const url = `${server.base}${sent.body.photoUrl}`;

  const own = await fetch(url, { headers: { authorization: `Bearer ${driver.token}` } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/jpeg');
  assert.equal(own.headers.get('cache-control'), 'private, max-age=1209600');
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), photo);

  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${other.token}` } })).status, 404);
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await api('GET', `/api/v1/reports/${withoutPhoto.body.id}/photo`, { token: driver.token })).status, 404);
  assert.equal((await api('GET', '/api/v1/reports/not-an-id/photo', { token: driver.token })).status, 404);
});

test('a compressed photo larger than the usual JSON limit still fits', async () => {
  const driver = await createUser();
  const response = await api('POST', '/api/v1/reports', { token: driver.token, body: report({ photo: jpeg(250 * 1024).toString('base64') }) });
  assert.equal(response.status, 201);
});

test('reports are validated', async () => {
  const driver = await createUser();
  const send = (body: unknown) => api('POST', '/api/v1/reports', { token: driver.token, body });

  assert.equal((await api('POST', '/api/v1/reports', { body: report() })).status, 401);
  assert.equal((await send(report({ spotId: 'P9-Z-99' }))).status, 404);
  assert.equal((await send(report({ kind: 'noisy' }))).status, 400);
  assert.equal((await send(report({ shownStatus: 'maybe' }))).status, 400);
  assert.equal((await send(report({ clientId: 'abc' }))).status, 400);
  assert.equal((await send(report({ note: 'x'.repeat(281) }))).status, 400);
  assert.deepEqual((await send(report({ photo: Buffer.from('not a photo').toString('base64') }))).body, { error: 'Photo must be a JPEG' });
  const large = await send(report({ photo: jpeg(301 * 1024).toString('base64') }));
  assert.equal(large.status, 413);
  assert.equal((await db().query('SELECT 1 FROM spot_reports')).rowCount, 0);
});

test('reports save the platform and default to android', async () => {
  const driver = await createUser();

  const ios = await api('POST', '/api/v1/reports', {
    token: driver.token,
    body: report({ platform: 'ios' })
  });

  const android = await api('POST', '/api/v1/reports', {
    token: driver.token,
    body: report()
  });

  assert.equal(ios.status, 201);
  assert.equal(android.status, 201);

  const { rows } = await db().query(
    'SELECT platform FROM spot_reports ORDER BY platform'
  );

  assert.deepEqual(rows, [
    { platform: 'android' },
    { platform: 'ios' }
  ]);
});

test('reports reject an unsupported platform', async () => {
  const driver = await createUser();

  const response = await api('POST', '/api/v1/reports', {
    token: driver.token,
    body: report({ platform: 'windows' })
  });

  assert.equal(response.status, 400);

  assert.equal(
    (await db().query('SELECT 1 FROM spot_reports')).rowCount,
    0
  );
});