import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { db } from '../src/db.js';
import { DAY_MS, slotLabel, slotStart } from '../src/time.js';
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
beforeEach(async () => {
  await db().query('DELETE FROM occupancy_snapshots');
  await db().query('DELETE FROM reservations');
});

async function snapshot(level: string, takenAt: string | Date, occupancy: number, total = 60) {
  const busy = Math.round(occupancy * total);
  const reserved = Math.min(busy, 2);
  await db().query(
    `INSERT INTO occupancy_snapshots (level_code, taken_at, total, free, reserved, occupied, source) VALUES ($1, $2, $3, $4, $5, $6, 'sim')`,
    [level, takenAt, total, total - busy, reserved, busy - reserved]
  );
}

test('predictions average the same weekday and slot of the last four weeks', async () => {
  await snapshot('P1', '2026-09-23T10:00:00-05:00', 0.5);
  await snapshot('P1', '2026-09-16T10:00:00-05:00', 0.6);
  await snapshot('P1', '2026-09-09T10:00:00-05:00', 0.7);
  await snapshot('P1', '2026-09-02T10:00:00-05:00', 0.8);
  await snapshot('P1', '2026-08-26T10:00:00-05:00', 0);
  await snapshot('P1', '2026-09-29T10:00:00-05:00', 1);
  await snapshot('P2', '2026-09-23T10:00:00-05:00', 0.3, 48);
  await snapshot('P1', '2026-09-23T23:45:00-05:00', 0.1);
  const response = await api('GET', '/api/v1/predictions?date=2026-09-30');
  assert.equal(response.status, 200);
  assert.equal(response.body.date, '2026-09-30');
  assert.equal(response.body.intervalMinutes, 15);
  assert.deepEqual(response.body.levels.map((level: { code: string }) => level.code), ['P1', 'P2', 'P3']);
  const point = (code: string, slot: string) => response.body.levels.find((level: { code: string }) => level.code === code).points.find((item: { slot: string }) => item.slot === slot).occupancy;
  assert.equal(response.body.levels[0].points.length, 96);
  assert.equal(response.body.levels[0].points[0].slot, '00:00');
  assert.equal(point('P1', '10:00'), 0.65);
  assert.equal(point('P1', '10:15'), null);
  assert.equal(point('P1', '23:45'), 0.1);
  assert.equal(point('P2', '10:00'), 0.292);
  assert.equal(point('P3', '10:00'), null);
  const filtered = await api('GET', '/api/v1/predictions?date=2026-09-30&level=P2');
  assert.deepEqual(filtered.body.levels.map((level: { code: string }) => level.code), ['P2']);
});

test('predictions validate inputs and default to today', async () => {
  assert.equal((await api('GET', '/api/v1/predictions?date=2026-02-30')).status, 400);
  assert.equal((await api('GET', '/api/v1/predictions?date=yesterday')).status, 400);
  assert.equal((await api('GET', '/api/v1/predictions?level=P9')).status, 404);
  const today = await api('GET', '/api/v1/predictions');
  assert.match(today.body.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('level recommendation picks the lowest predicted occupancy', async () => {
  const lastWeek = slotStart(new Date(Date.now() - 7 * DAY_MS));
  const twoWeeksAgo = new Date(lastWeek.getTime() - 7 * DAY_MS);
  for (const takenAt of [lastWeek, twoWeeksAgo]) {
    await snapshot('P1', takenAt, 0.9);
    await snapshot('P2', takenAt, 0.4, 48);
    await snapshot('P3', takenAt, 0.6, 48);
  }
  const arrivalAt = new Date(lastWeek.getTime() + 7 * DAY_MS + 5 * 60_000).toISOString();
  const response = await api('GET', `/api/v1/recommendations/level?arrivalAt=${encodeURIComponent(arrivalAt)}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.arrivalAt, arrivalAt);
  assert.equal(response.body.slot, slotLabel(lastWeek));
  assert.equal(response.body.recommended, 'P2');
  assert.deepEqual(response.body.levels, [
    { code: 'P1', predictedOccupancy: 0.9 },
    { code: 'P2', predictedOccupancy: 0.396 },
    { code: 'P3', predictedOccupancy: 0.604 }
  ]);
  const fallback = await api('GET', '/api/v1/recommendations/level');
  assert.ok(Math.abs(Date.parse(fallback.body.arrivalAt) - (Date.now() + 20 * 60_000)) < 10_000);
  assert.equal((await api('GET', '/api/v1/recommendations/level?arrivalAt=soon')).status, 400);
});

async function reservation(userId: string | null, source: string, status: string, travelMinutes: number | null) {
  await db().query(
    `INSERT INTO reservations (user_id, spot_id, source, status, created_at, expires_at, checked_in_at, released_at)
     VALUES ($1, 'P1-A-01', $2, $3, now() - interval '3 hours', now() - interval '3 hours' + interval '15 minutes',
             CASE WHEN $4::float8 IS NULL THEN NULL ELSE now() - interval '3 hours' + make_interval(mins => $4::int) END,
             CASE WHEN $3 IN ('released', 'cancelled') THEN now() - interval '1 hour' END)`,
    [userId, source, status, travelMinutes]
  );
}

test('lead time needs at least three reservations', async () => {
  const user = await createUser();
  await reservation(user.id, 'user', 'released', 10);
  await reservation(user.id, 'user', 'cancelled', null);
  const response = await api('GET', '/api/v1/recommendations/lead-time', { token: user.token });
  assert.equal(response.status, 200);
  assert.deepEqual({ ...response.body, message: undefined }, {
    reservationsConsidered: 1, holdMinutes: 15, p80TravelMinutes: null, expiredCount: null, suggestedReserveAfterLeavingMinutes: null, message: undefined
  });
  assert.ok(response.body.message.length > 10);
  assert.equal((await api('GET', '/api/v1/recommendations/lead-time')).status, 401);
});

test('lead time uses the 80th percentile of the user travel times', async () => {
  const user = await createUser();
  await reservation(user.id, 'user', 'released', 10);
  await reservation(user.id, 'user', 'released', 20);
  await reservation(user.id, 'user', 'released', 30);
  await reservation(user.id, 'user', 'expired', null);
  await reservation(user.id, 'user', 'cancelled', null);
  await reservation(null, 'sim', 'released', 90);
  const response = await api('GET', '/api/v1/recommendations/lead-time', { token: user.token });
  assert.deepEqual({ ...response.body, message: undefined }, {
    reservationsConsidered: 4, holdMinutes: 15, p80TravelMinutes: 24, expiredCount: 1, suggestedReserveAfterLeavingMinutes: 9, message: undefined
  });
  assert.match(response.body.message, /9 minutes after leaving/);
});
