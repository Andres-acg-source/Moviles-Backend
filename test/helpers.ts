import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, type AppOptions } from '../src/app.js';
import { closeDb, createClient, db, initDb, migrate } from '../src/db.js';
import { signToken } from '../src/middleware/auth.js';
import { seedDatabase } from '../src/seed.js';
import { register } from '../src/services/auth.js';

process.env.NODE_ENV = 'test';

export const directUrl = (url: string) => {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace('-pooler.', '.');
  return parsed.toString();
};

export async function setupTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set to run the tests');
  const connection = directUrl(url);
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = createClient(connection);
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  initDb(connection, schema);
  await migrate();
  await seedDatabase();
  return {
    schema,
    async cleanup() {
      await closeDb();
      const client = createClient(connection);
      await client.connect();
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  };
}

export async function startServer(options: AppOptions = {}) {
  const server = createApp(options).listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    })
  };
}

export async function createUser(name?: string) {
  const user = await register(`user_${randomBytes(5).toString('hex')}@parkwise.test`, 'secret123', name);
  return { ...user, token: signToken(user.id) };
}

export interface ApiResponse<T = any> { status: number; body: T; headers: Headers }

export function client(base: string) {
  return async <T = any>(method: string, path: string, options: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<ApiResponse<T>> => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined || options.raw !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers, body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
}

export async function setSpots(ids: string[], status: string, heldBy: string | null = null, source: string | null = null) {
  await db().query('UPDATE spots SET status = $2, held_by = $3, source = $4 WHERE id = ANY($1)', [ids, status, heldBy, source]);
}

export async function setAllSpots(status: string) {
  await db().query('UPDATE spots SET status = $1, held_by = NULL, source = NULL', [status]);
}
