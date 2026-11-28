import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { db } from '../src/db.js';
import { bogotaDate, bogotaMidnight, bogotaParts, DAY_MS, slotLabel, slotStart } from '../src/time.js';
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
  await db().query('DELETE FROM spot_reports');
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
  assert.deepEqual(Object.keys(await summary()).sort(), ['conversionFunnel', 'demandCapacity', 'eventCounts', 'filterUsage', 'generatedAt', 'leadTime', 'mapLoad', 'parking', 'predictionAccuracy', 'predictionUsage', 'redirectValue', 'reportMismatch', 'reservationFlow', 'reservationPolicy', 'reservations', 'searchModality', 'specialAvailability', 'unmetDemand', 'voiceRecognition', 'walkingTime', 'weekPlan']);
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
    { name: 'ok_event', properties: { empty: null } },
    { name: 'ok_event', properties: { occurredAt: 'not-a-timestamp' } }
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
  assert.deepEqual(body.parking, { total: 155, free: 151, reserved: 2, occupied: 2, disabled: 1, accessibleFree: 6, evFree: 6 });
  assert.equal(body.parking.total, body.parking.free + body.parking.reserved + body.parking.occupied);
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

test('reservation flow BQ11 measures request time, failures and crashes by device and OS version', async () => {
  const iphone = { deviceModel: 'iPhone 15', osVersion: '18.1', platform: 'ios' };
  const older = { deviceModel: 'iPhone 12', osVersion: '17.5', platform: 'ios' };
  for (const durationMs of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) await track('reservation_request', { ...iphone, durationMs, success: true });
  await db().query(`UPDATE telemetry_events SET properties = properties || '{"success": false, "errorType": "offline"}' WHERE (properties->>'durationMs')::int >= 900`);
  await track('reservation_request', { ...older, durationMs: 400, success: false, errorType: 'spot_taken' });
  for (let index = 0; index < 4; index++) await track('reserve_opened', iphone);
  await track('reserve_opened', older);
  await track('app_crash', { ...iphone, inReservationFlow: true, reason: 'NSRangeException: index out of bounds' });
  await track('app_crash', { ...iphone, inReservationFlow: false });
  const body = await summary();
  assert.deepEqual(body.reservationFlow, {
    totals: { requests: 11, medianMs: 500, p90Ms: 900, failureRate: 0.273, opens: 5, crashes: 1, crashesPer100Opens: 20 },
    byDevice: [
      { deviceModel: 'iPhone 12', osVersion: '17.5', requests: 1, medianMs: 400, p90Ms: 400, failureRate: 1, opens: 1, crashes: 0, crashesPer100Opens: 0 },
      { deviceModel: 'iPhone 15', osVersion: '18.1', requests: 10, medianMs: 550, p90Ms: 910, failureRate: 0.2, opens: 4, crashes: 1, crashesPer100Opens: 25 }
    ],
    errors: { offline: 2, spot_taken: 1 }
  });
});

test('prediction usage BQ8 classifies each user-day and only counts real check-ins', async () => {
  const [planned, liveOnly, simulatedOnly] = await Promise.all([createUser(), createUser(), createUser()]);
  const addEvent = (userId: string, name: string, createdAt: string, properties = {}) => db().query(
    'INSERT INTO telemetry_events (user_id, name, properties, created_at) VALUES ($1, $2, $3, $4)',
    [userId, name, properties, createdAt]
  );

  await addEvent(planned.id, 'forecast_viewed', '2026-10-14T09:00:00Z', { occurredAt: '2026-10-12T12:00:00Z' });
  await addEvent(planned.id, 'forecast_viewed', '2026-10-14T09:00:01Z', { occurredAt: '2026-10-12T12:10:00Z' });
  await addEvent(planned.id, 'availability_viewed', '2026-10-14T09:00:02Z', { occurredAt: '2026-10-12T13:00:00Z' });
  await addEvent(planned.id, 'forecast_viewed', '2026-10-14T09:00:03Z', { occurredAt: '2026-10-13T12:00:00Z' });

  await addEvent(liveOnly.id, 'availability_viewed', '2026-10-12T13:00:00Z', { occurredAt: '2026-10-12T13:00:00Z' });
  await addEvent(liveOnly.id, 'forecast_viewed', '2026-10-12T14:00:00Z', { occurredAt: '2026-10-12T14:00:00Z' });
  await addEvent(simulatedOnly.id, 'map_loaded', '2026-10-12T13:00:00Z', { success: true });

  await db().query(
    `INSERT INTO reservations (user_id, spot_id, source, status, created_at, expires_at, checked_in_at)
     VALUES ($1, 'P1-A-01', 'user', 'fulfilled', '2026-10-12T12:30:00Z', '2026-10-12T13:00:00Z', '2026-10-12T13:30:00Z'),
            ($2, 'P1-A-02', 'sim', 'fulfilled', '2026-10-12T12:30:00Z', '2026-10-12T13:00:00Z', '2026-10-12T13:30:00Z')`,
    [planned.id, simulatedOnly.id]
  );

  const body = (await summary()).predictionUsage;
  assert.deepEqual(body, {
    totalSessions: 4,
    forecastSessions: 2,
    liveOnlySessions: 2,
    forecastShare: 0.5,
    forecastParkingRate: 0.5,
    liveOnlyParkingRate: 0,
    parkingRateDifference: 0.5
  });
});

test('prediction usage BQ8 never places an event after the server received it', async () => {
  const user = await createUser();
  await db().query(
    `INSERT INTO telemetry_events (user_id, name, properties, created_at)
     VALUES ($1, 'forecast_viewed', $2, '2026-10-12T13:00:00Z'), ($1, 'availability_viewed', '{}', '2026-10-12T14:00:00Z')`,
    [user.id, { occurredAt: '2026-10-20T12:00:00Z' }]
  );
  const body = (await summary()).predictionUsage;
  assert.equal(body.totalSessions, 1);
  assert.equal(body.forecastSessions, 1);
});

test('prediction usage BQ8 returns null rates when there is no real telemetry', async () => {
  assert.deepEqual((await summary()).predictionUsage, {
    totalSessions: 0,
    forecastSessions: 0,
    liveOnlySessions: 0,
    forecastShare: null,
    forecastParkingRate: null,
    liveOnlyParkingRate: null,
    parkingRateDifference: null
  });
});

test('redirect value BQ9 counts redirects, answers and parked drivers per lot and hour of the redirect', async () => {
  const driver = await createUser();
  const day = bogotaMidnight(bogotaDate(new Date(Date.now() - 2 * DAY_MS)));
  const at = (hour: number, minute: number) => new Date(day.getTime() + (hour * 60 + minute) * 60_000).toISOString();
  const addEvent = (name: string, occurredAt: string, properties: Record<string, unknown>) => db().query(
    'INSERT INTO telemetry_events (user_id, name, properties, created_at) VALUES ($1, $2, $3, $4)',
    [driver.id, name, { ...properties, occurredAt }, occurredAt]
  );

  await addEvent('lot_redirected', at(13, 50), { lotId: 'nearby-1', platform: 'android' });
  await addEvent('lot_arrival_confirmed', at(14, 10), { lotId: 'nearby-1', parked: true, minutesAfter: 20, platform: 'android' });
  await addEvent('lot_redirected', at(13, 55), { lotId: 'nearby-1', platform: 'ios' });
  await addEvent('lot_arrival_confirmed', at(14, 0), { lotId: 'nearby-1', parked: false, minutesAfter: 5, platform: 'ios' });
  await addEvent('lot_redirected', at(8, 10), { lotId: 'nearby-2', platform: 'android' });
  await db().query(
    `INSERT INTO telemetry_events (name, properties, created_at) VALUES ('lot_redirected', '{"lotId": "nearby-2"}', now() - interval '40 days')`
  );

  const body = (await summary()).redirectValue;
  assert.deepEqual(body, {
    windowDays: 28,
    redirects: 3,
    answers: 2,
    parked: 1,
    answerRate: 0.667,
    parkedShare: 0.5,
    byLot: [
      { lotId: 'nearby-1', name: 'Park Central', redirects: 2, answers: 2, parked: 1, parkedShare: 0.5, estimatedDrivers: 1 },
      { lotId: 'nearby-2', name: 'City Parking', redirects: 1, answers: 0, parked: 0, parkedShare: null, estimatedDrivers: null }
    ],
    byLotHour: [
      { lotId: 'nearby-1', hour: '13:00', redirects: 2, answers: 2, parked: 1, parkedShare: 0.5 },
      { lotId: 'nearby-2', hour: '08:00', redirects: 1, answers: 0, parked: 0, parkedShare: null }
    ]
  });
});

test('redirect value BQ9 accepts the events from the apps and ignores a broken minutesAfter', async () => {
  const driver = await createUser();
  assert.equal((await track('lot_redirected', { lotId: 'nearby-2', platform: 'android' }, driver.token)).status, 202);
  assert.equal((await track('lot_arrival_confirmed', { lotId: 'nearby-2', parked: true, minutesAfter: 'soon', platform: 'android' }, driver.token)).status, 202);

  const body = (await summary()).redirectValue;
  assert.equal(body.redirects, 1);
  assert.equal(body.parked, 1);
  assert.deepEqual(body.byLot.map((lot: { lotId: string }) => lot.lotId), ['nearby-2']);
});

test('redirect value BQ9 is empty without redirects', async () => {
  assert.deepEqual((await summary()).redirectValue, {
    windowDays: 28,
    redirects: 0,
    answers: 0,
    parked: 0,
    answerRate: null,
    parkedShare: null,
    byLot: [],
    byLotHour: []
  });
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

test('prediction accuracy BQ10 compares each snapshot with the average of the same weekday and slot', async () => {
  const recent = slotStart(new Date(Date.now() - 2 * 86_400_000));
  const daysBefore = (days: number, minutes = 0) => new Date(recent.getTime() - days * 86_400_000 + minutes * 60_000);
  const snapshots: [string, Date, number][] = [
    ['P1', daysBefore(7), 50],
    ['P1', daysBefore(14), 70],
    ['P1', daysBefore(7, 15), 100],
    ['P1', daysBefore(6), 100],
    ['P1', recent, 90],
    ['P2', daysBefore(21), 20],
    ['P2', recent, 25],
    ['P3', recent, 40]
  ];
  for (const [level, takenAt, busy] of snapshots) {
    await db().query(
      `INSERT INTO occupancy_snapshots (level_code, taken_at, total, free, reserved, occupied, source) VALUES ($1, $2, 100, $3, $4, $5, 'sim')`,
      [level, takenAt, 100 - busy, Math.floor(busy / 5), busy - Math.floor(busy / 5)]
    );
  }
  assert.equal((await track('forecast_viewed', { platform: 'ios', screen: 'home', arrivalSlot: '08:00', source: 'home_open' })).status, 202);
  assert.equal((await track('forecast_viewed', { platform: 'ios', screen: 'home', arrivalSlot: '08:15', source: 'arrival_change' })).status, 202);
  assert.equal((await track('forecast_viewed', { platform: 'android', screen: 'home', arrivalSlot: '09:00', source: 'home_open' })).status, 202);
  await track('map_loaded', { platform: 'ios', levelCode: 'P1', durationMs: 120, success: true });
  await db().query(
    `INSERT INTO telemetry_events (name, properties, created_at) VALUES ('forecast_viewed', '{"platform": "ios"}', now() - interval '10 days')`
  );

  const body = (await summary()).predictionAccuracy;
  assert.equal(body.windowDays, 7);
  assert.deepEqual(body.forecastViews, { total: 3, byPlatform: [{ platform: 'ios', views: 2 }, { platform: 'android', views: 1 }] });
  assert.deepEqual(body.byLevel, [
    { level: 'P1', samples: 1, predictedAvg: 0.6, realAvg: 0.9, meanAbsError: 0.3 },
    { level: 'P2', samples: 1, predictedAvg: 0.2, realAvg: 0.25, meanAbsError: 0.05 }
  ]);
  for (const row of body.byLevel) assert.ok(row.samples > 0 && row.meanAbsError >= 0 && row.meanAbsError <= 1);
  assert.deepEqual(body.overall, { samples: 2, meanAbsError: 0.175 });
});

test('prediction accuracy BQ10 is empty without snapshots or forecast views', async () => {
  assert.deepEqual((await summary()).predictionAccuracy, {
    windowDays: 7,
    forecastViews: { total: 0, byPlatform: [] },
    byLevel: [],
    overall: { samples: 0, meanAbsError: null }
  });
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

test('lead time BQ6 overview groups the personal advice of every user', async () => {
  const [fast, slow, newcomer] = [await createUser(), await createUser(), await createUser()];
  let spotNumber = 0;
  const trips = async (userId: string, minutes: (number | 'expired')[]) => {
    for (const value of minutes) {
      const spot = `P3-A-${String(++spotNumber).padStart(2, '0')}`;
      if (value === 'expired') {
        await db().query(`INSERT INTO reservations (user_id, spot_id, source, status, created_at, expires_at) VALUES ($1, $2, 'user', 'expired', now() - interval '2 days', now() - interval '2 days')`, [userId, spot]);
      } else {
        await db().query(
          `INSERT INTO reservations (user_id, spot_id, source, status, created_at, expires_at, checked_in_at, released_at)
           VALUES ($1, $2, 'user', 'fulfilled', now() - interval '1 day', now(), now() - interval '1 day' + make_interval(mins => $3), now())`,
          [userId, spot, value]
        );
      }
    }
  };
  await trips(fast.id, [4, 6, 8]);
  await trips(slow.id, [20, 25, 'expired', 30]);
  await trips(newcomer.id, [5]);
  const body = (await summary()).leadTime;
  assert.equal(body.holdMinutes, 15);
  assert.equal(body.usersWithAdvice, 2);
  assert.equal(body.usersWithoutEnoughTrips, 1);
  assert.equal(body.expiredShare, 0.125);
  assert.deepEqual(body.buckets.map((bucket: { users: number }) => bucket.users), [1, 0, 0, 1, 0]);
  assert.equal(body.medianP80TravelMinutes, 17.1);
});

test('conversion funnel BQ7 follows each user and day through the reservation steps', async () => {
  const [a, b, c, d] = [await createUser(), await createUser(), await createUser(), await createUser()];
  const steps = async (user: { token: string }, names: string[], platform = 'android') => {
    for (const name of names) assert.equal((await track(name, { platform }, user.token)).status, 202);
  };
  await steps(a, ['availability_viewed', 'spot_selected', 'reserve_confirm_tapped']);
  await steps(b, ['availability_viewed', 'spot_selected', 'reserve_confirm_tapped']);
  await steps(c, ['availability_viewed', 'spot_selected'], 'ios');
  await steps(d, ['availability_viewed']);
  await track('spot_selected', { platform: 'android' });
  await track('reserve_failed', { reason: 'spot_taken' }, b.token);
  await track('reserve_failed', { reason: 'spot_taken' }, b.token);
  await track('reserve_failed', { reason: 'offline' }, c.token);
  await db().query(`INSERT INTO reservations (user_id, spot_id, source, status, expires_at) VALUES ($1, 'P1-A-01', 'user', 'active', now() + interval '15 minutes')`, [a.id]);
  await db().query(`INSERT INTO reservations (user_id, spot_id, source, status, expires_at) VALUES (NULL, 'P1-A-02', 'sim', 'active', now() + interval '15 minutes')`);

  const body = (await summary()).conversionFunnel;
  assert.equal(body.windowDays, 28);
  assert.deepEqual(body.steps.map((step: { count: number }) => step.count), [4, 3, 2, 1]);
  assert.deepEqual(body.steps.map((step: { fromPrevious: number | null }) => step.fromPrevious), [null, 0.75, 0.667, 0.5]);
  assert.equal(body.conversionRate, 0.25);
  assert.deepEqual(body.biggestDrop, { from: 'Tapped confirm', to: 'Reservation created', lost: 1, dropRate: 0.5 });
  assert.deepEqual(body.failures, [{ reason: 'spot_taken', count: 2 }, { reason: 'offline', count: 1 }]);
  const android = body.byPlatform.find((row: { platform: string }) => row.platform === 'android');
  assert.deepEqual(android, { platform: 'android', viewed: 3, selected: 2, confirmed: 2, reserved: 1, conversionRate: 0.333 });
  assert.equal(body.daily.length, 14);
  assert.deepEqual(body.daily.at(-1), { day: body.daily.at(-1).day, viewed: 4, reserved: 1, conversionRate: 0.25 });
});

test('search modality BQ13 counts each search once and checks whether it ended in a chosen spot', async () => {
  const driver = await createUser();
  const search = (searchId: string, mode: string, properties: Record<string, unknown> = {}) =>
    track('spot_search', { searchId, mode, resultCount: 4, fromCache: false, offline: false, platform: 'android', ...properties }, driver.token);
  const select = (searchId: string, mode: string) => track('spot_selected', { searchId, mode, platform: 'android' }, driver.token);

  for (const response of [
    await search('voice-1', 'voice'),
    await search('voice-2', 'voice', { resultCount: 0 }),
    await search('text-1', 'text'),
    await search('text-1', 'text'),
    await search('text-2', 'text', { voiceFallback: true }),
    await search('text-3', 'text', { platform: 'ios' }),
    await search('gesture-1', 'gesture'),
    await select('voice-1', 'voice'),
    await select('text-1', 'text'),
    await select('text-3', 'text'),
    await select('missing', 'text')
  ]) assert.equal(response.status, 202);
  await track('spot_search', { mode: 'voice', platform: 'android' }, driver.token);
  await db().query(
    `INSERT INTO telemetry_events (name, properties, created_at)
     VALUES ('spot_search', '{"searchId": "old", "mode": "voice", "platform": "android"}', now() - interval '40 days')`
  );

  assert.deepEqual((await summary()).searchModality, {
    windowDays: 28,
    searches: 5,
    voiceShare: 0.4,
    voiceAttempts: 3,
    keyboardFallbacks: 1,
    fallbackRate: 0.333,
    higherSelectionMode: 'text',
    byMode: [
      { mode: 'voice', searches: 2, selected: 1, selectionRate: 0.5, noResults: 1 },
      { mode: 'text', searches: 3, selected: 2, selectionRate: 0.667, noResults: 0 }
    ],
    byPlatform: [
      { platform: 'android', mode: 'voice', searches: 2, selected: 1, selectionRate: 0.5 },
      { platform: 'android', mode: 'text', searches: 2, selected: 1, selectionRate: 0.5 },
      { platform: 'ios', mode: 'text', searches: 1, selected: 1, selectionRate: 1 }
    ]
  });
});

test('search modality BQ13 is empty without searches', async () => {
  assert.deepEqual((await summary()).searchModality, {
    windowDays: 28,
    searches: 0,
    voiceShare: null,
    voiceAttempts: 0,
    keyboardFallbacks: 0,
    fallbackRate: null,
    higherSelectionMode: null,
    byMode: [
      { mode: 'voice', searches: 0, selected: 0, selectionRate: null, noResults: 0 },
      { mode: 'text', searches: 0, selected: 0, selectionRate: null, noResults: 0 }
    ],
    byPlatform: []
  });
});

test('week plan BQ14 finds the best slot of each level near the usual arrival hour', async () => {
  const driver = await createUser();
  const midnight = bogotaMidnight(bogotaDate(new Date())).getTime();
  const weekdayIn = (days: number) => bogotaParts(new Date(midnight + days * DAY_MS)).weekday;
  const later = (days: number) => bogotaDate(new Date(midnight + days * DAY_MS));
  const sameWeekdayBefore = (days: number, hour: number) => new Date(midnight + (days - 7) * DAY_MS + hour * 3_600_000);
  const [first, second] = [1, 2, 3, 4, 5, 6].filter(days => weekdayIn(days) >= 1 && weekdayIn(days) <= 5);
  const sunday = [0, 1, 2, 3, 4, 5, 6].find(days => weekdayIn(days) === 0)!;
  const snapshots: [string, Date, number, number][] = [
    ['P1', sameWeekdayBefore(first, 8), 54, 60],
    ['P1', sameWeekdayBefore(first, 9), 42, 60],
    ['P1', sameWeekdayBefore(second, 7), 30, 60],
    ['P1', sameWeekdayBefore(second, 17), 6, 60],
    ['P1', sameWeekdayBefore(sunday, 8), 3, 60],
    ['P2', sameWeekdayBefore(first, 8), 19, 48]
  ];
  for (const [level, takenAt, busy, total] of snapshots) {
    await db().query(
      `INSERT INTO occupancy_snapshots (level_code, taken_at, total, free, reserved, occupied, source) VALUES ($1, $2, $3, $4, 0, $5, 'sim')`,
      [level, takenAt, total, total - busy, busy]
    );
  }
  for (const response of [
    await track('week_viewed', { level: 'P1', arrivalHour: 8, offline: false, platform: 'android' }, driver.token),
    await track('week_viewed', { level: 'P2', arrivalHour: 8, offline: true, platform: 'android' }, driver.token),
    await track('week_viewed', { level: 'P1', arrivalHour: 17, offline: false, platform: 'ios' }, driver.token),
    await track('week_viewed', { arrivalHour: 'eight', platform: 'android' }, driver.token),
    await track('week_slot_used', { day: later(first), hour: 8, level: 'P2', predicted: 40, platform: 'android' }, driver.token)
  ]) assert.equal(response.status, 202);
  await db().query(
    `INSERT INTO telemetry_events (name, properties, created_at)
     VALUES ('week_viewed', '{"level": "P3", "arrivalHour": 12, "platform": "android"}', now() - interval '40 days')`
  );

  assert.deepEqual((await summary()).weekPlan, {
    windowDays: 28,
    from: later(0),
    views: 4,
    slotsUsed: 1,
    useRate: 0.25,
    usualArrivalHour: 8,
    nearHours: 1,
    arrivalHours: [{ hour: 8, views: 2 }, { hour: 17, views: 1 }],
    byLevel: [
      { level: 'P1', best: { date: later(second), weekday: weekdayIn(second), hour: 7, occupancy: 0.5 }, views: 2, slotsUsed: 0 },
      { level: 'P2', best: { date: later(first), weekday: weekdayIn(first), hour: 8, occupancy: 0.396 }, views: 1, slotsUsed: 1 },
      { level: 'P3', best: null, views: 0, slotsUsed: 0 }
    ],
    byPlatform: [
      { platform: 'android', views: 3, slotsUsed: 1 },
      { platform: 'ios', views: 1, slotsUsed: 0 }
    ]
  });
});

test('week plan BQ14 is empty without history or views', async () => {
  assert.deepEqual((await summary()).weekPlan, {
    windowDays: 28,
    from: bogotaDate(new Date()),
    views: 0,
    slotsUsed: 0,
    useRate: null,
    usualArrivalHour: null,
    nearHours: 1,
    arrivalHours: [],
    byLevel: ['P1', 'P2', 'P3'].map(level => ({ level, best: null, views: 0, slotsUsed: 0 })),
    byPlatform: []
  });
});

test('report mismatch BQ15 counts the reports that contradict the state shown, by level and hour', async () => {
  const driver = await createUser();
  const midnight = bogotaMidnight(bogotaDate(new Date())).getTime();
  const at = (daysAgo: number, hour: number, minute = 0) => new Date(midnight - daysAgo * DAY_MS + hour * 3_600_000 + minute * 60_000);
  const reports: [string, string, string, Date][] = [
    ['P2-A-14', 'occupied', 'free', at(1, 8, 10)],
    ['P2-A-15', 'blocked', 'free', at(2, 8, 40)],
    ['P2-A-16', 'damaged', 'free', at(3, 8, 5)],
    ['P2-A-17', 'occupied', 'occupied', at(1, 8, 20)],
    ['P1-A-01', 'occupied', 'free', at(1, 17)],
    ['P1-A-02', 'other', 'reserved', at(5, 17, 30)],
    ['P3-B-02', 'occupied', 'free', at(40, 8)]
  ];
  for (const [spot, kind, shown, reportedAt] of reports) {
    await db().query(
      `INSERT INTO spot_reports (user_id, client_id, spot_id, level_code, kind, shown_status, reported_at)
       VALUES ($1, gen_random_uuid(), $2, split_part($2, '-', 1), $3, $4, $5)`,
      [driver.id, spot, kind, shown, reportedAt]
    );
  }

  assert.deepEqual((await summary()).reportMismatch, {
    windowDays: 28,
    reports: 6,
    contradicting: 3,
    mismatchRate: 0.5,
    worstSlot: { level: 'P2', hour: 8, reports: 4, contradicting: 2, mismatchRate: 0.5 },
    byLevel: [
      { level: 'P1', reports: 2, contradicting: 1, mismatchRate: 0.5 },
      { level: 'P2', reports: 4, contradicting: 2, mismatchRate: 0.5 },
      { level: 'P3', reports: 0, contradicting: 0, mismatchRate: null }
    ],
    bySlot: [
      { level: 'P1', hour: 17, reports: 2, contradicting: 1, mismatchRate: 0.5 },
      { level: 'P2', hour: 8, reports: 4, contradicting: 2, mismatchRate: 0.5 }
    ]
  });
});

test('report mismatch BQ15 is empty without reports', async () => {
  assert.deepEqual((await summary()).reportMismatch, {
    windowDays: 28,
    reports: 0,
    contradicting: 0,
    mismatchRate: null,
    worstSlot: null,
    byLevel: ['P1', 'P2', 'P3'].map(level => ({ level, reports: 0, contradicting: 0, mismatchRate: null })),
    bySlot: []
  });
});

test('voice recognition BQ16 times the attempts that worked and counts the failures by cause, device and level', async () => {
  const driver = await createUser();
  const iphone = { platform: 'ios', deviceModel: 'iPhone15,2', osVersion: '18.1' };
  const attempt = (properties: Record<string, unknown>) => track('voice_recognition', properties, driver.token);

  for (const response of [
    await attempt({ ...iphone, outcome: 'ok', latencyMs: 1000, level: 'P2' }),
    await attempt({ ...iphone, outcome: 'ok', latencyMs: 2000, level: 'P2' }),
    await attempt({ ...iphone, outcome: 'ok', latencyMs: 3000 }),
    await attempt({ platform: 'android', deviceModel: 'Pixel 7', osVersion: '14', outcome: 'ok', latencyMs: 4000 }),
    await attempt({ ...iphone, outcome: 'offline', latencyMs: 300 })
  ]) assert.equal(response.status, 202);
  await db().query(
    `INSERT INTO telemetry_events (name, properties, created_at)
     VALUES ('voice_recognition', '{"outcome": "error", "latencyMs": 500, "platform": "ios"}', now() - interval '40 days')`
  );

  assert.deepEqual((await summary()).voiceRecognition, {
    windowDays: 28,
    attempts: 5,
    failures: 1,
    failureRate: 0.2,
    medianMs: 2500,
    p90Ms: 3700,
    byOutcome: [
      { outcome: 'ok', attempts: 4, share: 0.8 },
      { outcome: 'offline', attempts: 1, share: 0.2 }
    ],
    byPlatform: [
      { platform: 'android', attempts: 1, medianMs: 4000, p90Ms: 4000, failureRate: 0 },
      { platform: 'ios', attempts: 4, medianMs: 2000, p90Ms: 2800, failureRate: 0.25 }
    ],
    byDevice: [
      { platform: 'ios', deviceModel: 'iPhone15,2', osVersion: '18.1', attempts: 4, medianMs: 2000, p90Ms: 2800, failureRate: 0.25 },
      { platform: 'android', deviceModel: 'Pixel 7', osVersion: '14', attempts: 1, medianMs: 4000, p90Ms: 4000, failureRate: 0 }
    ],
    byLevel: [
      { level: 'P2', attempts: 2, failureRate: 0 },
      { level: 'none', attempts: 3, failureRate: 0.333 }
    ]
  });
});

test('voice recognition BQ16 is empty without attempts', async () => {
  assert.deepEqual((await summary()).voiceRecognition, {
    windowDays: 28,
    attempts: 0,
    failures: 0,
    failureRate: null,
    medianMs: null,
    p90Ms: null,
    byOutcome: [],
    byPlatform: [],
    byDevice: [],
    byLevel: []
  });
});

test('demand capacity BQ17 adds the unmet demand split by capacity to the hourly peak of each level', async () => {
  const midnight = bogotaMidnight(bogotaDate(new Date())).getTime();
  const at = (daysAgo: number, hour: number, minute = 0) => new Date(midnight - daysAgo * DAY_MS + hour * 3_600_000 + minute * 60_000);
  const weekday = bogotaParts(new Date(midnight)).weekday;
  const snapshots: [string, Date, number, number, number][] = [
    ['P1', at(7, 8), 60, 50, 0],
    ['P1', at(7, 8, 45), 60, 50, 8],
    ['P1', at(14, 8, 15), 60, 54, 0],
    ['P2', at(7, 8, 30), 48, 44, 4],
    ['P2', at(14, 8), 48, 46, 0],
    ['P1', at(7, 21), 60, 60, 0],
    ['P2', at(40, 8), 48, 48, 0]
  ];
  for (const [level, takenAt, total, occupied, reserved] of snapshots) {
    await db().query(
      `INSERT INTO occupancy_snapshots (level_code, taken_at, total, free, reserved, occupied, source) VALUES ($1, $2, $3, $4, $5, $6, 'sim')`,
      [level, takenAt, total, total - occupied - reserved, reserved, occupied]
    );
  }
  const unmet = [at(7, 8), at(7, 8), at(7, 8, 15), at(7, 8, 30), at(7, 8, 45), at(7, 8, 45), at(14, 8), at(14, 8, 30), at(7, 10)];
  for (const slot of unmet) {
    await db().query(
      `INSERT INTO unmet_demand (user_id, slot_start, weekday, zone) VALUES (gen_random_uuid(), $1, $2, '4.60,-74.07')`,
      [slot, bogotaParts(slot).weekday]
    );
  }

  assert.deepEqual((await summary()).demandCapacity, {
    windowDays: 28,
    hours: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    levels: [
      { code: 'P1', capacity: 60, slots: [{ weekday, hour: 8, demand: 57.538, ratio: 0.959, over: false }], overSlots: 0 },
      { code: 'P2', capacity: 48, slots: [{ weekday, hour: 8, demand: 48.231, ratio: 1.005, over: true }], overSlots: 1 },
      { code: 'P3', capacity: 48, slots: [], overSlots: 0 }
    ],
    worst: { level: 'P2', weekday, hour: 8, ratio: 1.005 }
  });
});

test('demand capacity BQ17 is empty without snapshots', async () => {
  assert.deepEqual((await summary()).demandCapacity, {
    windowDays: 28,
    hours: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    levels: [
      { code: 'P1', capacity: 60, slots: [], overSlots: 0 },
      { code: 'P2', capacity: 48, slots: [], overSlots: 0 },
      { code: 'P3', capacity: 48, slots: [], overSlots: 0 }
    ],
    worst: null
  });
});
