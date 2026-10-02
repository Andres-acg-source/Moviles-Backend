import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
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

test('health reports database status', async () => {
  const response = await api('GET', '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', db: 'ok' });
});

test('malformed JSON returns 400 and oversized bodies 413', async () => {
  const malformed = await api('POST', '/api/v1/auth/login', { raw: '{"email": ' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { error: 'Malformed JSON' });
  const large = await api('POST', '/api/v1/telemetry', { raw: JSON.stringify({ name: 'big', properties: { blob: 'x'.repeat(110_000) } }) });
  assert.equal(large.status, 413);
  assert.equal(large.body.error, 'Payload too large');
});

test('unknown routes return a JSON 404', async () => {
  for (const path of ['/api/v1/nope', '/api/v1/lots', '/api/v1/payments', '/whatever']) {
    const response = await api('GET', path);
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'Not found' });
  }
  assert.equal((await api('POST', '/api/v1/check-out')).status, 404);
  assert.equal((await api('PUT', '/api/v1/vehicle')).status, 404);
});

test('telemetry stores the user id when a token is present', async () => {
  const user = await createUser();
  assert.equal((await api('POST', '/api/v1/telemetry', { token: user.token, body: { name: 'app_opened', properties: { platform: 'ios' } } })).status, 202);
  assert.equal((await api('POST', '/api/v1/telemetry', { body: { name: 'app_opened' } })).status, 202);
  assert.equal((await api('POST', '/api/v1/telemetry', { token: 'garbage', body: { name: 'app_opened' } })).status, 202);
  const { rows } = await db().query(`SELECT user_id FROM telemetry_events WHERE name = 'app_opened' ORDER BY id`);
  assert.deepEqual(rows.map(row => row.user_id), [user.id, null, null]);
});

test('auth endpoints are rate limited per IP', async () => {
  const limited = await startServer({ authLimitPerMinute: 3 });
  const call = client(limited.base);
  try {
    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt++) statuses.push((await call('POST', '/api/v1/auth/login', { body: { email: 'nobody@parkwise.test', password: 'x' } })).status);
    assert.deepEqual(statuses, [401, 401, 401, 429]);
    const blocked = await call('POST', '/api/v1/auth/register', { body: { email: 'new@parkwise.test', password: 'secret123' } });
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, { error: 'Too many requests' });
  } finally {
    await limited.close();
  }
});

test('default auth limit allows 10 attempts per minute', async () => {
  const fresh = await startServer();
  const call = client(fresh.base);
  try {
    const statuses = [];
    for (let attempt = 0; attempt < 11; attempt++) statuses.push((await call('POST', '/api/v1/auth/login', { body: { email: 'nobody@parkwise.test', password: 'x' } })).status);
    assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
  } finally {
    await fresh.close();
  }
});
