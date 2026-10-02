import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { jwtSecret } from '../src/config.js';
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

test('register, login and me', async () => {
  const registered = await api('POST', '/api/v1/auth/register', { body: { name: 'Nicolas', email: ' Driver@Uniandes.edu.co ', password: 'secret123' } });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.user.email, 'driver@uniandes.edu.co');
  assert.equal(registered.body.user.name, 'Nicolas');
  assert.ok(registered.body.user.id);
  assert.equal((await api('POST', '/api/v1/auth/register', { body: { email: 'driver@uniandes.edu.co', password: 'other123' } })).status, 409);
  assert.equal((await api('POST', '/api/v1/auth/register', { body: { email: 'not-an-email', password: 'secret123' } })).status, 400);
  const short = await api('POST', '/api/v1/auth/register', { body: { email: 'short@uniandes.edu.co', password: '123' } });
  assert.equal(short.status, 400);
  assert.ok(short.body.details);
  const me = await api('GET', '/api/v1/auth/me', { token: registered.body.token });
  assert.deepEqual(me.body, { id: registered.body.user.id, email: 'driver@uniandes.edu.co', name: 'Nicolas' });
  const login = await api('POST', '/api/v1/auth/login', { body: { email: 'DRIVER@uniandes.edu.co', password: 'secret123' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, registered.body.user.id);
  assert.equal((await api('POST', '/api/v1/auth/login', { body: { email: 'driver@uniandes.edu.co', password: 'wrong-pass' } })).status, 401);
  assert.equal((await api('POST', '/api/v1/auth/login', { body: { email: 'nobody@uniandes.edu.co', password: 'secret123' } })).status, 401);
});

test('auth rejects missing, malformed and foreign tokens', async () => {
  const user = await createUser();
  assert.equal((await api('GET', '/api/v1/auth/me')).status, 401);
  assert.equal((await api('GET', '/api/v1/auth/me', { headers: { authorization: user.token } })).status, 401);
  assert.equal((await api('GET', '/api/v1/auth/me', { headers: { authorization: `Token ${user.token}` } })).status, 401);
  assert.equal((await api('GET', '/api/v1/auth/me', { token: 'invalid' })).status, 401);
  const wrongAlgorithm = jwt.sign({ sub: user.id }, jwtSecret(), { algorithm: 'HS512' });
  assert.equal((await api('GET', '/api/v1/auth/me', { token: wrongAlgorithm })).status, 401);
  const response = await api('GET', '/api/v1/auth/me', { token: user.token });
  assert.equal(response.status, 200);
  assert.equal(response.body.name, '');
});

test('token of a deleted user is rejected', async () => {
  const user = await createUser();
  await db().query('DELETE FROM users WHERE id = $1', [user.id]);
  const response = await api('GET', '/api/v1/auth/me', { token: user.token });
  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'User no longer exists');
});
