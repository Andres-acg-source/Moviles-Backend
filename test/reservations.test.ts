import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { db } from '../src/db.js';
import { expireReservations } from '../src/services/reservations-expiry.js';
import { client, createUser, setAllSpots, setupTestDb, startServer } from './helpers.js';

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
  await db().query('DELETE FROM reservations');
  await setAllSpots('free');
  delete process.env.HOLD_MINUTES;
});

const spotStatus = async (id: string) => (await db().query('SELECT status, held_by, source FROM spots WHERE id = $1', [id])).rows[0];

test('20 concurrent reservations of the same spot produce exactly one winner', async () => {
  const users = await Promise.all(Array.from({ length: 20 }, () => createUser()));
  const responses = await Promise.all(users.map(user => api('POST', '/api/v1/reservations', { token: user.token, body: { spotId: 'P2-B-10' } })));
  const statuses = responses.map(response => response.status).sort();
  assert.deepEqual(statuses, [201, ...Array(19).fill(409)]);
  const winner = responses.find(response => response.status === 201)!;
  const owner = users[responses.indexOf(winner)];
  assert.deepEqual(await spotStatus('P2-B-10'), { status: 'reserved', held_by: owner.id, source: 'user' });
  assert.equal((await db().query(`SELECT 1 FROM reservations WHERE spot_id = 'P2-B-10'`)).rowCount, 1);
});

test('reservation response matches the contract', async () => {
  const user = await createUser();
  const response = await api('POST', '/api/v1/reservations', { token: user.token, body: { spotId: 'P1-A-01' } });
  assert.equal(response.status, 201);
  assert.deepEqual(Object.keys(response.body).sort(), ['checkedInAt', 'createdAt', 'expiresAt', 'id', 'levelCode', 'releasedAt', 'spotCode', 'spotId', 'status']);
  assert.deepEqual([response.body.spotId, response.body.spotCode, response.body.levelCode, response.body.status, response.body.checkedInAt, response.body.releasedAt], ['P1-A-01', 'A-01', 'P1', 'active', null, null]);
  const holdMs = Date.parse(response.body.expiresAt) - Date.parse(response.body.createdAt);
  assert.ok(Math.abs(holdMs - 15 * 60_000) < 1000);
  assert.equal((await api('POST', '/api/v1/reservations', { token: user.token, body: { spotId: 'P9-Z-99' } })).status, 404);
  assert.equal((await api('POST', '/api/v1/reservations', { token: user.token, body: {} })).status, 400);
  assert.equal((await api('POST', '/api/v1/reservations', { body: { spotId: 'P1-A-02' } })).status, 401);
});

test('a user cannot hold two active reservations', async () => {
  const user = await createUser();
  assert.equal((await api('POST', '/api/v1/reservations', { token: user.token, body: { spotId: 'P1-A-04' } })).status, 201);
  const second = await api('POST', '/api/v1/reservations', { token: user.token, body: { spotId: 'P1-A-05' } });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'An active reservation already exists');
  assert.equal((await spotStatus('P1-A-05')).status, 'free');
  const racer = await createUser();
  const spots = ['P1-A-06', 'P1-A-07', 'P1-A-08', 'P1-A-09'];
  const race = await Promise.all(spots.map(spotId => api('POST', '/api/v1/reservations', { token: racer.token, body: { spotId } })));
  assert.deepEqual(race.map(response => response.status).sort(), [201, 409, 409, 409]);
  const held = await db().query(`SELECT id FROM spots WHERE id = ANY($1) AND status = 'reserved'`, [spots]);
  assert.equal(held.rowCount, 1);
});

test('nobody can check in or release a reservation they do not own', async () => {
  const owner = await createUser();
  const intruder = await createUser();
  const reservation = (await api('POST', '/api/v1/reservations', { token: owner.token, body: { spotId: 'P1-B-01' } })).body;
  assert.equal((await api('POST', `/api/v1/reservations/${reservation.id}/check-in`, { token: intruder.token })).status, 404);
  assert.equal((await api('POST', `/api/v1/reservations/${reservation.id}/release`, { token: intruder.token })).status, 404);
  assert.equal((await api('POST', '/api/v1/reservations/not-a-uuid/release', { token: owner.token })).status, 404);
  assert.deepEqual(await spotStatus('P1-B-01'), { status: 'reserved', held_by: owner.id, source: 'user' });
});

test('expired reservations free the spot and cannot be checked in', async () => {
  const user = await createUser();
  const reservation = (await api('POST', '/api/v1/reservations', { token: user.token, body: { spotId: 'P1-C-01' } })).body;
  await db().query(`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [reservation.id]);
  assert.deepEqual(await expireReservations(), { expired: 1, freed: 1 });
  assert.deepEqual(await spotStatus('P1-C-01'), { status: 'free', held_by: null, source: null });
  const checkIn = await api('POST', `/api/v1/reservations/${reservation.id}/check-in`, { token: user.token });
  assert.equal(checkIn.status, 409);
  assert.equal(checkIn.body.error, 'Reservation has expired');
  assert.equal((await api('GET', '/api/v1/reservations/active', { token: user.token })).body, null);
});

test('a short HOLD_MINUTES expires reservations on the next request', async () => {
  process.env.HOLD_MINUTES = '1';
  const user = await createUser();
  const reservation = (await api('POST', '/api/v1/reservations', { token: user.token, body: { spotId: 'P1-C-02' } })).body;
  assert.ok(Date.parse(reservation.expiresAt) - Date.parse(reservation.createdAt) <= 61_000);
  await db().query(`UPDATE reservations SET created_at = created_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE id = $1`, [reservation.id]);
  const checkIn = await api('POST', `/api/v1/reservations/${reservation.id}/check-in`, { token: user.token });
  assert.equal(checkIn.status, 409);
  assert.equal((await spotStatus('P1-C-02')).status, 'free');
  assert.equal((await api('POST', '/api/v1/reservations', { token: user.token, body: { spotId: 'P1-C-03' } })).status, 201);
});

test('reserve, check in and release leaves the spot free', async () => {
  const user = await createUser();
  const reservation = (await api('POST', '/api/v1/reservations', { token: user.token, body: { spotId: 'P3-A-10' } })).body;
  assert.equal((await api('GET', '/api/v1/reservations/active', { token: user.token })).body.id, reservation.id);
  assert.equal((await api('GET', '/api/v1/vehicle', { token: user.token })).body, null);
  const checkedIn = await api('POST', `/api/v1/reservations/${reservation.id}/check-in`, { token: user.token });
  assert.equal(checkedIn.status, 200);
  assert.equal(checkedIn.body.status, 'fulfilled');
  assert.ok(checkedIn.body.checkedInAt);
  assert.deepEqual(await spotStatus('P3-A-10'), { status: 'occupied', held_by: user.id, source: 'user' });
  assert.equal((await api('POST', `/api/v1/reservations/${reservation.id}/check-in`, { token: user.token })).status, 409);
  const vehicle = await api('GET', '/api/v1/vehicle', { token: user.token });
  assert.deepEqual(vehicle.body, { spotId: 'P3-A-10', spotCode: 'A-10', levelCode: 'P3', zone: 'A', parkedAt: checkedIn.body.checkedInAt });
  assert.equal((await api('GET', '/api/v1/reservations/active', { token: user.token })).body.status, 'fulfilled');
  const released = await api('POST', `/api/v1/reservations/${reservation.id}/release`, { token: user.token });
  assert.equal(released.status, 200);
  assert.equal(released.body.status, 'released');
  assert.ok(released.body.releasedAt);
  assert.deepEqual(await spotStatus('P3-A-10'), { status: 'free', held_by: null, source: null });
  assert.equal((await api('GET', '/api/v1/vehicle', { token: user.token })).body, null);
  assert.equal((await api('GET', '/api/v1/reservations/active', { token: user.token })).body, null);
  assert.equal((await api('POST', `/api/v1/reservations/${reservation.id}/release`, { token: user.token })).status, 409);
});

test('releasing an active reservation cancels it', async () => {
  const user = await createUser();
  const reservation = (await api('POST', '/api/v1/reservations', { token: user.token, body: { spotId: 'P2-A-05' } })).body;
  const released = await api('POST', `/api/v1/reservations/${reservation.id}/release`, { token: user.token });
  assert.equal(released.body.status, 'cancelled');
  assert.equal((await spotStatus('P2-A-05')).status, 'free');
  assert.equal((await api('POST', `/api/v1/reservations/${reservation.id}/check-in`, { token: user.token })).status, 409);
});

test('reservation history is newest first', async () => {
  const user = await createUser();
  const ids = [];
  for (const spotId of ['P2-B-01', 'P2-B-02', 'P2-B-03']) {
    const reservation = (await api('POST', '/api/v1/reservations', { token: user.token, body: { spotId } })).body;
    await api('POST', `/api/v1/reservations/${reservation.id}/release`, { token: user.token });
    ids.push(reservation.id);
  }
  const history = await api('GET', '/api/v1/reservations/me', { token: user.token });
  assert.deepEqual(history.body.map((item: { id: string }) => item.id), ids.reverse());
  assert.deepEqual((await api('GET', '/api/v1/reservations/me', { token: (await createUser()).token })).body, []);
});
