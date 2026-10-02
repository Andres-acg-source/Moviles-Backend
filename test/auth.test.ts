import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';

const start = async (file: string) => {
  const server = (await createApp(file)).listen(0); const address = server.address(); assert.ok(address && typeof address === 'object');
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
};
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('auth register, login, me and persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parkwise-auth-')); const file = join(directory, 'data.json'); const servers: Array<{ close: () => Promise<void> }> = [];
  try {
    const first = await start(file); servers.push(first);
    const registered = await post(`${first.base}/api/v1/auth/register`, { name: 'Nicolas', email: ' Driver@Uniandes.edu.co ', password: 'secret123' }); assert.equal(registered.status, 201);
    const account = await registered.json() as { token: string; user: { email: string; name: string } }; assert.equal(account.user.email, 'driver@uniandes.edu.co'); assert.equal(account.user.name, 'Nicolas');
    assert.equal((await post(`${first.base}/api/v1/auth/register`, { email: 'driver@uniandes.edu.co', password: 'other123' })).status, 409);
    assert.equal((await post(`${first.base}/api/v1/auth/register`, { email: 'not-an-email', password: 'secret123' })).status, 400);
    assert.equal((await post(`${first.base}/api/v1/auth/register`, { email: 'short@uniandes.edu.co', password: '123' })).status, 400);
    const me = await fetch(`${first.base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${account.token}` } }); assert.equal(me.status, 200); assert.deepEqual(await me.json().then(body => [body.email, body.name]), ['driver@uniandes.edu.co', 'Nicolas']);
    assert.equal((await fetch(`${first.base}/api/v1/auth/me`)).status, 401);
    assert.equal((await fetch(`${first.base}/api/v1/auth/me`, { headers: { authorization: 'Bearer invalid' } })).status, 401);
    const second = await start(file); servers.push(second);
    assert.equal((await post(`${second.base}/api/v1/auth/login`, { email: 'driver@uniandes.edu.co', password: 'secret123' })).status, 200);
    assert.equal((await post(`${second.base}/api/v1/auth/login`, { email: 'driver@uniandes.edu.co', password: 'wrong-pass' })).status, 401);
    assert.equal((await post(`${second.base}/api/v1/auth/login`, { email: 'nobody@uniandes.edu.co', password: 'secret123' })).status, 401);
  } finally { await Promise.all(servers.map(server => server.close())); await rm(directory, { recursive: true, force: true }); }
});
