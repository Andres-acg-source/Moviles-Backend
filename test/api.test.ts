import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';

test('parking, auth, reservation and vehicle flows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parkwise-')); const app = await createApp(join(directory, 'data.json')); const server = app.listen(0); const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}/health`); assert.equal(health.status, 200);
    const registered = await fetch(`${base}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com', password: 'secret123' }) }); const account = await registered.json() as { token: string }; assert.equal(registered.status, 201);
    const lots = await fetch(`${base}/api/v1/lots`); const lotData = await lots.json() as Array<{ id: string; levels: Array<{ spots: Array<{ id: string; state: string }> }> }>; assert.equal(lotData.length, 3); const spotId = lotData[0].levels[0].spots.find(spot => spot.state === 'free')!.id;
    const search = await fetch(`${base}/api/v1/spots/search?available=true&accessible=true`); assert.equal(search.status, 200); assert.ok((await search.json()).length > 0);
    const nearby = await fetch(`${base}/api/v1/nearby-lots`); assert.equal((await nearby.json()).length, 2);
    const queue = await fetch(`${base}/api/v1/lots/p1/queue`); assert.equal((await queue.json()).lotId, 'p1');
    const reservation = await fetch(`${base}/api/v1/reservations`, { method: 'POST', headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ lotId: 'p1', spotId, durationMinutes: 60 }) }); assert.equal(reservation.status, 201); const saved = await reservation.json() as { id: string };
    const active = await fetch(`${base}/api/v1/reservations/active`, { headers: { authorization: `Bearer ${account.token}` } }); assert.equal((await active.json()).id, saved.id);
    const vehicle = await fetch(`${base}/api/v1/vehicle`, { method: 'PUT', headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ lotId: 'p1', lotName: 'P1 · North', levelName: 'Level 1', spotCode: 'A-01' }) }); assert.equal(vehicle.status, 200);
    const permit = await fetch(`${base}/api/v1/permit`, { method: 'PUT', headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'ev', expiresAt: '2027-01-01T00:00:00.000Z', verified: true }) }); assert.equal(permit.status, 200);
    const paymentHeaders = { authorization: `Bearer ${account.token}`, 'content-type': 'application/json', 'Idempotency-Key': 'test-payment-1' };
    const payment = await fetch(`${base}/api/v1/payments`, { method: 'POST', headers: paymentHeaders, body: JSON.stringify({ amount: 5000, purpose: 'reservation', reservationId: saved.id }) }); assert.equal(payment.status, 201); const repeatedPayment = await fetch(`${base}/api/v1/payments`, { method: 'POST', headers: paymentHeaders, body: JSON.stringify({ amount: 5000, purpose: 'reservation', reservationId: saved.id }) }); assert.equal((await repeatedPayment.json()).id, (await payment.clone().json()).id);
    const cancelled = await fetch(`${base}/api/v1/reservations/${saved.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${account.token}` } }); assert.equal(cancelled.status, 204);
    const secondSpot = lotData[0].levels[0].spots.find(spot => spot.id !== spotId && spot.state === 'free')!.id;
    const secondReservation = await fetch(`${base}/api/v1/reservations`, { method: 'POST', headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ lotId: 'p1', spotId: secondSpot, durationMinutes: 60 }) }); const secondSaved = await secondReservation.json() as { id: string }; assert.equal(secondReservation.status, 201);
    const checkIn = await fetch(`${base}/api/v1/reservations/${secondSaved.id}/check-in`, { method: 'POST', headers: { authorization: `Bearer ${account.token}` } }); assert.equal(checkIn.status, 200);
    const checkOut = await fetch(`${base}/api/v1/check-out`, { method: 'POST', headers: { authorization: `Bearer ${account.token}` } }); assert.equal(checkOut.status, 200);
    const telemetry = await fetch(`${base}/api/v1/telemetry`, { method: 'POST', headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'reservation_confirmed', properties: { source: 'test' } }) }); assert.equal(telemetry.status, 202);
    const analytics = await fetch(`${base}/api/v1/analytics/summary`, { headers: { authorization: `Bearer ${account.token}` } }); assert.equal(analytics.status, 200); assert.ok((await analytics.json()).parking.totalSpots > 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});