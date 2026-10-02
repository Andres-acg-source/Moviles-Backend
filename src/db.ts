import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export type Db = pg.Pool | pg.PoolClient;

const MIGRATION_LOCK = 727_274_001;
const migrationsDir = new URL('../migrations/', import.meta.url);

let pool: pg.Pool | undefined;

function connectionConfig(connectionString: string, schema?: string): pg.PoolConfig {
  const url = new URL(connectionString);
  const wantsSsl = ['require', 'verify-ca', 'verify-full', 'prefer'].includes(url.searchParams.get('sslmode') ?? '') || url.hostname.endsWith('neon.tech');
  const channelBinding = url.searchParams.get('channel_binding') === 'require';
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  return {
    connectionString: url.toString(),
    ssl: wantsSsl ? { rejectUnauthorized: true } : undefined,
    enableChannelBinding: channelBinding,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    options: schema ? `-c search_path=${schema}` : undefined
  };
}

export function initDb(connectionString: string, schema?: string) {
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid schema name');
  pool = new pg.Pool(connectionConfig(connectionString, schema));
  pool.on('error', error => console.error('[db] idle client error:', error.message));
  return pool;
}

export function db() {
  if (!pool) throw new Error('Database pool is not initialized');
  return pool;
}

export function createClient(connectionString: string) {
  const { max, idleTimeoutMillis, ...config } = connectionConfig(connectionString);
  return new pg.Client(config);
}

export async function closeDb() {
  const current = pool;
  pool = undefined;
  await current?.end();
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>) {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate() {
  const files = (await readdir(migrationsDir)).filter(file => file.endsWith('.sql')).sort();
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map(row => row.name));
    const pending = files.filter(file => !applied.has(file));
    for (const file of pending) {
      await client.query(await readFile(new URL(file, migrationsDir), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
    return pending;
  });
}

export const isUniqueViolation = (error: unknown, constraint?: string) =>
  error instanceof Error && (error as { code?: string }).code === '23505' && (!constraint || (error as { constraint?: string }).constraint === constraint);
