import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { db } from '../src/db.js';
import { ensureHistory } from '../src/simulation/history.js';
import { baseOccupancy } from '../src/simulation/profile.js';
import { clearSimulatedOccupancy } from '../src/simulation/clear.js';
import { clearScenarios } from '../src/simulation/scenarios.js';
import { SimulatedOccupancySource } from '../src/simulation/simulator.js';
import { client, createUser, setAllSpots, setupTestDb, startServer } from './helpers.js';

const WEDNESDAY_10AM = new Date('2026-09-30T15:00:00Z');

const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

let cleanup: () => Promise<void>;
let server: Awaited<ReturnType<typeof startServer>>;
let api: ReturnType<typeof client>;
const simulator = new SimulatedOccupancySource({ now: () => WEDNESDAY_10AM, random: seeded(42) });

before(async () => {
  ({ cleanup } = await setupTestDb());
  server = await startServer({ occupancy: simulator });
  api = client(server.base);
});
after(async () => { clearScenarios(); await server.close(); await cleanup(); });
beforeEach(async () => {
  clearScenarios();
  process.env.SIM_KEY = 'test-sim-key';
  await db().query('DELETE FROM reservations');
  await setAllSpots('free');
});

const occupancyByLevel = async () => {
  const { rows } = await db().query<{ code: string; ratio: number }>(
    `SELECT level_code AS code, count(*) FILTER (WHERE status IN ('occupied', 'reserved'))::float8 / count(*) FILTER (WHERE status <> 'disabled') AS ratio
       FROM spots GROUP BY 1 ORDER BY 1`
  );
  return rows;
};

const userSpots = async () => (await db().query(`SELECT id, status, held_by, source FROM spots WHERE source = 'user' OR held_by IS NOT NULL ORDER BY id`)).rows;

test('occupancy converges to the profile target', async () => {
  for (let tick = 0; tick < 8; tick++) await simulator.tick();
  for (const level of await occupancyByLevel()) {
    const target = baseOccupancy(level.code, WEDNESDAY_10AM);
    assert.ok(Math.abs(level.ratio - target) <= 0.1, `${level.code}: ${level.ratio} vs ${target}`);
  }
  const { rows } = await db().query(`SELECT count(*)::int AS count FROM spots WHERE status IN ('occupied', 'reserved') AND source IS DISTINCT FROM 'sim'`);
  assert.equal(rows[0].count, 0);
  assert.ok((await db().query('SELECT 1 FROM occupancy_snapshots')).rowCount! >= 3);
});

test('tick never touches spots held by users', async () => {
  const reserver = await createUser();
  const parker = await createUser();
  const reserved = (await api('POST', '/api/v1/reservations', { token: reserver.token, body: { spotId: 'P1-A-01' } })).body;
  const parked = (await api('POST', '/api/v1/reservations', { token: parker.token, body: { spotId: 'P2-A-01' } })).body;
  await api('POST', `/api/v1/reservations/${parked.id}/check-in`, { token: parker.token });
  const before = await userSpots();
  assert.equal(before.length, 2);
  for (let tick = 0; tick < 4; tick++) await simulator.tick();
  assert.deepEqual(await userSpots(), before);
  await api('POST', '/api/v1/sim/scenario', { headers: { 'x-sim-key': 'test-sim-key' }, body: { occupancy: 0 } });
  assert.deepEqual(await userSpots(), before);
  await api('POST', '/api/v1/sim/scenario', { headers: { 'x-sim-key': 'test-sim-key' }, body: { occupancy: 100 } });
  assert.deepEqual(await userSpots(), before);
  assert.equal((await db().query('SELECT status FROM reservations WHERE id = $1', [reserved.id])).rows[0].status, 'active');
});

test('clearing simulated occupancy frees every simulator spot and keeps user reservations', async () => {
  const reserver = await createUser();
  const reserved = (await api('POST', '/api/v1/reservations', { token: reserver.token, body: { spotId: 'P1-A-01' } })).body;
  for (let tick = 0; tick < 6; tick++) await simulator.tick({ force: true });
  const busy = await db().query(`SELECT count(*)::int AS n FROM spots WHERE source = 'sim' AND status IN ('occupied', 'reserved')`);
  assert.ok(busy.rows[0].n > 0);
  assert.equal(await clearSimulatedOccupancy(), busy.rows[0].n);
  const { rows } = await db().query<{ id: string; status: string }>(`SELECT id, status FROM spots WHERE status <> 'free' AND status <> 'disabled'`);
  assert.deepEqual(rows, [{ id: 'P1-A-01', status: 'reserved' }]);
  const open = await db().query(`SELECT count(*)::int AS n FROM reservations WHERE source = 'sim' AND (status = 'active' OR (status = 'fulfilled' AND released_at IS NULL))`);
  assert.equal(open.rows[0].n, 0);
  assert.equal((await db().query('SELECT status FROM reservations WHERE id = $1', [reserved.id])).rows[0].status, 'active');
});

test('a 100% scenario fills the campus and reset returns to the profile', async () => {
  const user = await createUser();
  await api('POST', '/api/v1/reservations', { token: user.token, body: { spotId: 'P3-B-05' } });
  const applied = await api('POST', '/api/v1/sim/scenario', { headers: { 'x-sim-key': 'test-sim-key' }, body: { occupancy: 100, minutes: 5 } });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.applied, true);
  assert.ok(Date.parse(applied.body.until) > Date.now());
  await simulator.tick();
  const levels = await api('GET', '/api/v1/levels');
  assert.equal(levels.body.campusFull, true);
  assert.deepEqual((await db().query(`SELECT status, held_by FROM spots WHERE id = 'P3-B-05'`)).rows[0], { status: 'reserved', held_by: user.id });
  const reset = await api('POST', '/api/v1/sim/reset', { headers: { 'x-sim-key': 'test-sim-key' } });
  assert.deepEqual(reset.body, { reset: true });
  assert.equal((await api('GET', '/api/v1/levels')).body.campusFull, false);
});

test('a scenario can target a single level', async () => {
  const applied = await api('POST', '/api/v1/sim/scenario', { headers: { 'x-sim-key': 'test-sim-key' }, body: { level: 'P2', occupancy: 0 } });
  assert.equal(applied.status, 200);
  const levels = (await api('GET', '/api/v1/levels')).body.levels as Array<{ code: string; free: number; total: number }>;
  const p2 = levels.find(level => level.code === 'P2')!;
  assert.equal(p2.free, p2.total);
  assert.equal((await api('POST', '/api/v1/sim/scenario', { headers: { 'x-sim-key': 'test-sim-key' }, body: { level: 'P7', occupancy: 50 } })).status, 404);
});

test('simulator endpoints require the right key', async () => {
  assert.equal((await api('POST', '/api/v1/sim/reset', { headers: { 'x-sim-key': 'wrong' } })).status, 403);
  assert.equal((await api('POST', '/api/v1/sim/scenario', { body: { occupancy: 50 } })).status, 403);
  assert.equal((await api('POST', '/api/v1/sim/scenario', { headers: { 'x-sim-key': 'test-sim-key' }, body: { occupancy: 150 } })).status, 400);
  assert.equal((await api('POST', '/api/v1/sim/scenario', { headers: { 'x-sim-key': 'test-sim-key' }, body: { occupancy: 50, minutes: 500 } })).status, 400);
  delete process.env.SIM_KEY;
  assert.equal((await api('POST', '/api/v1/sim/reset', { headers: { 'x-sim-key': 'test-sim-key' } })).status, 404);
});

test('initial history is generated only once', async () => {
  await db().query('DELETE FROM occupancy_snapshots');
  assert.equal(await ensureHistory({ now: WEDNESDAY_10AM, random: seeded(7) }), true);
  const snapshots = (await db().query('SELECT count(*)::int AS count FROM occupancy_snapshots')).rows[0].count;
  assert.equal(snapshots, 3 * (28 * 96 + 1));
  const reservations = await db().query(`SELECT status, count(*)::int AS count FROM reservations WHERE source = 'sim' GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(reservations.rows.map(row => row.status), ['expired', 'released']);
  const released = reservations.rows.find(row => row.status === 'released').count;
  const expired = reservations.rows.find(row => row.status === 'expired').count;
  assert.ok(released / (released + expired) > 0.7 && released / (released + expired) < 0.9);
  assert.equal(await ensureHistory({ now: WEDNESDAY_10AM }), false);
  assert.equal((await db().query('SELECT count(*)::int AS count FROM occupancy_snapshots')).rows[0].count, snapshots);
});
