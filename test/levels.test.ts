import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { client, createUser, setAllSpots, setSpots, setupTestDb, startServer } from './helpers.js';

let cleanup: () => Promise<void>;
let server: Awaited<ReturnType<typeof startServer>>;
let api: ReturnType<typeof client>;

before(async () => {
  ({ cleanup } = await setupTestDb());
  server = await startServer();
  api = client(server.base);
});
after(async () => { await server.close(); await cleanup(); });
beforeEach(async () => { await setAllSpots('free'); });

test('buildings and nearby lots', async () => {
  const buildings = await api('GET', '/api/v1/buildings');
  assert.equal(buildings.body.length, 4);
  assert.deepEqual(Object.keys(buildings.body[0]).sort(), ['id', 'name']);
  const nearby = await api('GET', '/api/v1/nearby-lots');
  assert.deepEqual(nearby.body.map((lot: { id: string }) => lot.id), ['nearby-1', 'nearby-2']);
  assert.deepEqual(Object.keys(nearby.body[0]).sort(), ['address', 'currency', 'id', 'imageUrl', 'name', 'ratePerHour', 'walkMinutes']);
});

test('nearby lots link the photo saved for each lot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'parkwise-images-'));
  await writeFile(join(dir, 'nearby-1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(join(dir, 'notes.txt'), 'not a photo');
  const photos = await startServer({ imagesDir: dir });
  try {
    const call = client(photos.base);
    const nearby = await call('GET', '/api/v1/nearby-lots');
    assert.deepEqual(nearby.body.map((lot: { id: string; imageUrl: string | null }) => [lot.id, lot.imageUrl]), [
      ['nearby-1', '/images/nearby-1.jpg'],
      ['nearby-2', null]
    ]);
    const photo = await fetch(`${photos.base}/images/nearby-1.jpg`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.match(photo.headers.get('cache-control') ?? '', /max-age=2592000/);
    assert.equal((await fetch(`${photos.base}/images/nearby-2.jpg`)).status, 404);
    assert.equal((await fetch(`${photos.base}/images/notes.txt`)).status, 404);
  } finally {
    await photos.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('level counts report unavailable spots separately from usable capacity', async () => {
  await setSpots(['P1-A-01', 'P1-A-02', 'P1-A-03', 'P1-A-04', 'P1-A-05'], 'reserved');
  await setSpots(['P1-B-01', 'P1-B-02', 'P1-B-03'], 'occupied');
  await setSpots(['P2-A-01'], 'disabled');
  const response = await api('GET', '/api/v1/levels');
  assert.equal(response.status, 200);
  assert.equal(response.body.campusFull, false);
  assert.ok(Date.parse(response.body.generatedAt));
  const levels = response.body.levels.map(({ name, ...level }: { name: string }) => level);
  assert.deepEqual(levels, [
    { code: 'P1', underground: false, total: 60, free: 52, reserved: 5, occupied: 3, disabled: 0 },
    { code: 'P2', underground: true, total: 47, free: 47, reserved: 0, occupied: 0, disabled: 1 },
    { code: 'P3', underground: true, total: 48, free: 48, reserved: 0, occupied: 0, disabled: 0 }
  ]);
  for (const level of levels) {
    assert.equal(level.total, level.free + level.reserved + level.occupied);
  }
  assert.equal(levels[1].total + levels[1].disabled, 48);
  const p2Spots = await api('GET', '/api/v1/levels/P2/spots');
  assert.equal(p2Spots.body.length, 48);
  assert.equal(p2Spots.body.filter((spot: { status: string }) => spot.status === 'disabled').length, 1);
});

test('campusFull is true only when no spot is free', async () => {
  await setAllSpots('occupied');
  await setSpots(['P3-B-24'], 'disabled');
  assert.equal((await api('GET', '/api/v1/levels')).body.campusFull, true);
  await setSpots(['P3-B-23'], 'free');
  assert.equal((await api('GET', '/api/v1/levels')).body.campusFull, false);
});

test('spot filters', async () => {
  await setSpots(['P1-A-01'], 'reserved');
  const count = async (query: string) => (await api('GET', `/api/v1/levels/P1/spots${query}`)).body.length;
  assert.equal(await count(''), 60);
  assert.equal(await count('?accessible=true'), 3);
  assert.equal(await count('?ev=true'), 3);
  assert.equal(await count('?vip=true'), 3);
  assert.equal(await count('?available=true'), 59);
  assert.equal(await count('?available=true&accessible=true'), 2);
  assert.equal(await count('?accessible=1'), 60);
  const [spot] = (await api('GET', '/api/v1/levels/P2/spots?ev=true')).body;
  assert.deepEqual(Object.keys(spot).sort(), ['code', 'id', 'isAccessible', 'isEv', 'isVip', 'levelCode', 'mine', 'status', 'walkMinutes', 'zone']);
  assert.deepEqual([spot.id, spot.code, spot.zone, spot.levelCode, spot.isEv], ['P2-A-02', 'A-02', 'A', 'P2', true]);
});

test('walk minutes grow with underground levels and depend on destination', async () => {
  const minutes = async (level: string, destination?: string) => {
    const query = destination ? `?destination=${destination}` : '';
    const spots = (await api('GET', `/api/v1/levels/${level}/spots${query}`)).body as Array<{ code: string; walkMinutes: number }>;
    return spots.find(spot => spot.code === 'A-05')!.walkMinutes;
  };
  const p1 = await minutes('P1');
  const p3 = await minutes('P3');
  assert.equal(p1, 2);
  assert.ok(p3 > p1);
  assert.equal(p3, 4);
  assert.equal(await minutes('P1', 'ml'), p1);
  assert.ok((await minutes('P1', 'deportivo')) > p1);
  for (const level of ['P1', 'P2', 'P3']) {
    for (const destination of ['ml', 'sd', 'biblioteca', 'deportivo']) {
      const spots = (await api('GET', `/api/v1/levels/${level}/spots?destination=${destination}`)).body as Array<{ walkMinutes: number }>;
      assert.ok(spots.every(spot => spot.walkMinutes >= 1 && spot.walkMinutes <= 9), `${level} ${destination}`);
    }
  }
});

test('mine is true only for the holder', async () => {
  const owner = await createUser();
  const other = await createUser();
  await setSpots(['P1-C-07'], 'reserved', owner.id, 'user');
  const mine = async (token?: string) => ((await api('GET', '/api/v1/levels/P1/spots', { token })).body as Array<{ id: string; mine: boolean }>)
    .filter(spot => spot.mine).map(spot => spot.id);
  assert.deepEqual(await mine(owner.token), ['P1-C-07']);
  assert.deepEqual(await mine(other.token), []);
  assert.deepEqual(await mine(), []);
});

test('unknown level is 404 and unknown destination is 400', async () => {
  const level = await api('GET', '/api/v1/levels/P9/spots');
  assert.equal(level.status, 404);
  assert.equal(level.body.error, 'Level not found');
  const destination = await api('GET', '/api/v1/levels/P1/spots?destination=nowhere');
  assert.equal(destination.status, 400);
  assert.equal(destination.body.error, 'Destination building not found');
});
