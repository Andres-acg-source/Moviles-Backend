import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { db } from '../src/db.js';
import { bogotaParts, slotLabel, slotStart } from '../src/time.js';
import { client, createUser, setAllSpots, setSpots, setupTestDb, startServer } from './helpers.js';

let cleanup: () => Promise<void>;
let server: Awaited<ReturnType<typeof startServer>>;
let api: ReturnType<typeof client>;
let viewer: Awaited<ReturnType<typeof createUser>>;

before(async () => {
  ({ cleanup } = await setupTestDb());
  server = await startServer();
  api = client(server.base);
  viewer = await createUser();
});
after(async () => { await server.close(); await cleanup(); });
beforeEach(async () => {
  await db().query('DELETE FROM telemetry_events');
  await db().query('DELETE FROM reservations');
  await db().query('DELETE FROM unmet_demand');
  await db().query('DELETE FROM occupancy_snapshots');
  await setAllSpots('free');
});

const summary = async () => {
  const response = await api('GET', '/api/v1/analytics/summary', { token: viewer.token });
  assert.equal(response.status, 200);
  return response.body;
};
const track = (name: string, properties: Record<string, unknown>, token?: string) => api('POST', '/api/v1/telemetry', { token, body: { name, properties } });

test('summary requires authentication and has every section', async () => {
  assert.equal((await api('GET', '/api/v1/analytics/summary')).status, 401);
  assert.deepEqual(Object.keys(await summary()).sort(), ['eventCounts', 'filterUsage', 'generatedAt', 'mapLoad', 'parking', 'reservationPolicy', 'reservations', 'unmetDemand', 'walkingTime']);
});

test('telemetry rejects invalid names and properties', async () => {
  const invalid = [
    { name: 'MapLoaded', properties: {} },
    { name: 'map-loaded', properties: {} },
    { name: 'x'.repeat(101), properties: {} },
    { name: 'ok_event', properties: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`k${index}`, index])) },
    { name: 'ok_event', properties: { ['k'.repeat(41)]: 1 } },
    { name: 'ok_event', properties: { nested: { a: 1 } } },
    { name: 'ok_event', properties: { list: [1, 2] } },
    { name: 'ok_event', properties: { text: 'x'.repeat(201) } },
    { name: 'ok_event', properties: { empty: null } }
  ];
  for (const body of invalid) assert.equal((await api('POST', '/api/v1/telemetry', { body })).status, 400, JSON.stringify(body).slice(0, 60));
  const valid = { name: 'ok_event', properties: { ...Object.fromEntries(Array.from({ length: 19 }, (_, index) => [`k${index}`, index])), text: 'x'.repeat(200) } };
  assert.equal((await api('POST', '/api/v1/telemetry', { body: valid })).status, 202);
  assert.equal((await api('POST', '/api/v1/telemetry', { body: { name: 'no_properties' } })).status, 202);
  assert.deepEqual((await summary()).eventCounts, { no_properties: 1, ok_event: 1 });
});

test('parking and reservations sections', async () => {
  await setSpots(['P1-A-01', 'P1-A-04'], 'reserved');
  await setSpots(['P1-B-02', 'P2-A-05'], 'occupied');
  await setSpots(['P3-A-06'], 'disabled');
  const user = await createUser();
  await db().query(
    `INSERT INTO reservations (user_id, spot_id, source, status, expires_at) VALUES
       ($1, 'P1-A-01', 'user', 'active', now() + interval '10 minutes'),
       ($1, 'P1-A-02', 'user', 'cancelled', now()),
       (NULL, 'P1-A-04', 'sim', 'active', now() + interval '10 minutes'),
       (NULL, 'P1-A-05', 'sim', 'expired', now()),
       (NULL, 'P1-A-06', 'sim', 'expired', now())`,
    [user.id]
  );
  const body = await summary();
  assert.deepEqual(body.parking, { total: 155, free: 151, reserved: 2, occupied: 2, accessibleFree: 6, evFree: 6 });
  assert.deepEqual(body.reservations.user, { active: 1, fulfilled: 0, released: 0, cancelled: 1, expired: 0 });
  assert.deepEqual(body.reservations.sim, { active: 1, fulfilled: 0, released: 0, cancelled: 0, expired: 2 });
  assert.deepEqual(body.reservations.total, { active: 2, fulfilled: 0, released: 0, cancelled: 1, expired: 2 });
});

test('walking time BQ2 aggregation', async () => {
  for (const [levelCode, minutes] of [['P1', 2], ['P1', 3], ['P2', 6]] as const) {
    assert.equal((await track('walking_time_viewed', { spotCode: 'A-01', levelCode, minutes, source: 'map' })).status, 202);
  }
  await track('walking_time_viewed', { levelCode: 'P3', minutes: 'seven' });
  const body = await summary();
  assert.equal(body.eventCounts.walking_time_viewed, 4);
  assert.deepEqual(body.walkingTime, { views: 3, averageMinutes: 3.7, byLevel: { P1: { views: 2, averageMinutes: 2.5 }, P2: { views: 1, averageMinutes: 6 } } });
});

test('map load BQ1 groups by device, OS version and level', async () => {
  const device = { deviceModel: 'iPhone 15', osVersion: '18.1', platform: 'ios', levelCode: 'P1' };
  for (const durationMs of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) await track('map_loaded', { ...device, durationMs, success: true });
  await db().query(`UPDATE telemetry_events SET properties = properties || '{"success": false, "errorType": "timeout"}' WHERE (properties->>'durationMs')::int >= 900`);
  await track('map_loaded', { deviceModel: 'Pixel 8', osVersion: '15', platform: 'android', levelCode: 'P2', durationMs: 250, success: true });
  const body = await summary();
  assert.deepEqual(body.mapLoad, [
    { deviceModel: 'Pixel 8', osVersion: '15', levelCode: 'P2', loads: 1, avgMs: 250, p90Ms: 250, failureRate: 0 },
    { deviceModel: 'iPhone 15', osVersion: '18.1', levelCode: 'P1', loads: 10, avgMs: 550, p90Ms: 910, failureRate: 0.2 }
  ]);
});

test('filter usage BQ3 for the current month', async () => {
  const [a, b, c, d] = await Promise.all([createUser(), createUser(), createUser(), createUser()]);
  for (const user of [a, b, c, d]) await track('app_opened', { platform: 'ios' }, user.token);
  await track('app_opened', { platform: 'ios' }, a.token);
  await track('filter_applied', { filter: 'available' }, a.token);
  await track('filter_applied', { filter: 'available' }, a.token);
  await track('filter_applied', { filter: 'available' }, b.token);
  await track('filter_applied', { filter: 'vip' }, c.token);
  await track('filter_applied', { filter: 'unknown' }, c.token);
  await track('filter_applied', { filter: 'electric' });
  await db().query(`INSERT INTO telemetry_events (user_id, name, properties, created_at) VALUES ($1, 'filter_applied', '{"filter": "accessible"}', now() - interval '45 days')`, [d.id]);
  const body = (await summary()).filterUsage;
  assert.match(body.month, /^\d{4}-\d{2}$/);
  assert.equal(body.activeUsers, 4);
  assert.deepEqual(body.filters, {
    available: { uses: 3, usesPerActiveUser: 0.75, percentNeverUsed: 50 },
    vip: { uses: 1, usesPerActiveUser: 0.25, percentNeverUsed: 75 },
    electric: { uses: 1, usesPerActiveUser: 0.25, percentNeverUsed: 100 },
    accessible: { uses: 0, usesPerActiveUser: 0, percentNeverUsed: 100 }
  });
});

test('unmet demand BQ4 counts once per user and slot when the campus is full', async () => {
  const [a, b] = await Promise.all([createUser(), createUser()]);
  await api('GET', '/api/v1/levels?zone=4.60,-74.07', { token: a.token });
  assert.deepEqual((await summary()).unmetDemand, { total: 0, rows: [] });
  await setAllSpots('occupied');
  await api('GET', '/api/v1/levels?zone=4.60,-74.07', { token: a.token });
  await api('GET', '/api/v1/levels?zone=4.60,-74.07', { token: a.token });
  await api('GET', '/api/v1/levels?zone=4.60,-74.07', { token: b.token });
  await api('GET', '/api/v1/levels?zone=4.61,-74.08', { token: b.token });
  await api('GET', '/api/v1/levels?zone=4.60,-74.07');
  await api('GET', '/api/v1/levels?zone=bogota', { token: a.token });
  await api('GET', '/api/v1/levels?zone=4.6,-74.07', { token: a.token });
  const now = new Date();
  const body = (await summary()).unmetDemand;
  assert.deepEqual(body, { total: 2, rows: [{ weekday: bogotaParts(now).weekday, slot: slotLabel(now), zone: '4.60,-74.07', count: 2 }] });
  const stored = await db().query('SELECT slot_start FROM unmet_demand LIMIT 1');
  assert.equal(stored.rows[0].slot_start.getTime(), slotStart(now).getTime());
});

test('reservation policy BQ5 by level, slot and source', async () => {
  const user = await createUser();
  const slot = new Date(slotStart(new Date(Date.now() - 2 * 86_400_000)).getTime() + 60_000);
  const insert = (userId: string | null, source: string, status: string, checkInMinutes: number | null, spotId: string) => db().query(
    `INSERT INTO reservations (user_id, spot_id, source, status, created_at, expires_at, checked_in_at, released_at)
     VALUES ($1, $2, $3, $4, $5, $5::timestamptz + interval '15 minutes',
             CASE WHEN $6::int IS NULL THEN NULL ELSE $5::timestamptz + make_interval(mins => $6::int) END,
             CASE WHEN $4 = 'released' THEN $5::timestamptz + interval '2 hours' END)`,
    [userId, spotId, source, status, slot, checkInMinutes]
  );
  for (const minutes of [4, 6, 8, 10, 12, 14, 16, 18, 20, 22]) await insert(null, 'sim', 'released', minutes, 'P1-A-10');
  for (let index = 0; index < 4; index++) await insert(null, 'sim', 'expired', null, 'P1-A-11');
  await insert(user.id, 'user', 'released', 5, 'P1-A-12');
  await insert(user.id, 'user', 'expired', null, 'P1-A-12');
  await db().query(
    `INSERT INTO occupancy_snapshots (level_code, taken_at, total, free, reserved, occupied, source) VALUES ('P1', $1, 60, 0, 0, 60, 'sim')`,
    [slotStart(slot)]
  );
  const body = (await summary()).reservationPolicy;
  assert.equal(body.windowDays, 28);
  assert.equal(body.holdMinutes, 15);
  assert.equal(body.rows.length, 1);
  const row = body.rows[0];
  assert.equal(row.levelCode, 'P1');
  assert.equal(row.slot, slotLabel(slot));
  assert.deepEqual(row.sim, { created: 14, fulfilled: 10, expired: 4, noShowRate: 0.286, p90CheckInMinutes: 20.2, recommendedWindowMinutes: 20, heldSpots: 0 });
  assert.deepEqual(row.user, { created: 2, fulfilled: 1, expired: 1, noShowRate: 0.5, p90CheckInMinutes: 5, recommendedWindowMinutes: 10, heldSpots: 0 });
  assert.equal(row.total.created, 16);
  assert.equal(row.total.fulfilled, 11);
  assert.equal(row.total.expired, 5);
  assert.equal(row.total.noShowRate, 0.313);
});

test('reservation policy held spots scale with daily demand and are capped by free spots', async () => {
  const slot = new Date(slotStart(new Date(Date.now() - 3_600_000)).getTime() + 60_000);
  await db().query(
    `INSERT INTO reservations (user_id, spot_id, source, status, created_at, expires_at, checked_in_at, released_at)
     SELECT NULL, 'P2-A-' || lpad(((n % 24) + 1)::text, 2, '0'), 'sim', 'released', $1::timestamptz - make_interval(days => n % 28),
            $1::timestamptz + interval '15 minutes', $1::timestamptz + interval '6 minutes', $1::timestamptz + interval '1 hour'
       FROM generate_series(0, 139) AS n`,
    [slot]
  );
  let row = (await summary()).reservationPolicy.rows.find((item: { levelCode: string }) => item.levelCode === 'P2');
  assert.equal(row.sim.created, 140);
  assert.equal(row.sim.heldSpots, 5);
  await db().query(`INSERT INTO occupancy_snapshots (level_code, taken_at, total, free, reserved, occupied, source) VALUES ('P2', $1, 48, 3, 0, 45, 'sim')`, [slotStart(slot)]);
  row = (await summary()).reservationPolicy.rows.find((item: { levelCode: string }) => item.levelCode === 'P2');
  assert.equal(row.sim.heldSpots, 3);
});
