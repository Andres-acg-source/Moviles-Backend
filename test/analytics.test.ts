import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';

test('walking time BQ2 aggregation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parkwise-analytics-')); const server = (await createApp(join(directory, 'data.json'))).listen(0); const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  try {
    const track = (properties: Record<string, string | number>) => fetch(`${base}/api/v1/telemetry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'walking_time_viewed', properties }) });
    for (const [levelCode, minutes] of [['P1', 2], ['P1', 3], ['P2', 6]] as const) assert.equal((await track({ spotCode: 'A101', levelCode, minutes, source: 'map' })).status, 202);
    const registered = await fetch(`${base}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'bq2@uniandes.edu.co', password: 'secret123' }) }); const { token } = await registered.json() as { token: string };
    const summary = await (await fetch(`${base}/api/v1/analytics/summary`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(summary.eventCounts.walking_time_viewed, 3);
    assert.deepEqual(summary.walkingTime, { views: 3, averageMinutes: 3.7, byLevel: { P1: { views: 2, averageMinutes: 2.5 }, P2: { views: 1, averageMinutes: 6 } } });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
