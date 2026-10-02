import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { db, migrate } from '../src/db.js';
import { seedDatabase } from '../src/seed.js';
import { setupTestDb } from './helpers.js';

let cleanup: () => Promise<void>;
before(async () => { ({ cleanup } = await setupTestDb()); });
after(async () => { await cleanup(); });

test('migrations are idempotent', async () => {
  assert.deepEqual(await migrate(), []);
  const { rows } = await db().query('SELECT name FROM schema_migrations ORDER BY name');
  assert.deepEqual(rows.map(row => row.name), ['001_init.sql', '002_reservation_locks.sql']);
});

test('seed creates 156 unique free spots and is idempotent', async () => {
  await seedDatabase();
  const { rows } = await db().query(`SELECT count(*)::int AS total, count(DISTINCT id)::int AS unique_ids, count(*) FILTER (WHERE status = 'free')::int AS free FROM spots`);
  assert.deepEqual(rows[0], { total: 156, unique_ids: 156, free: 156 });
  const perLevel = await db().query('SELECT level_code, count(*)::int AS count FROM spots GROUP BY 1 ORDER BY 1');
  assert.deepEqual(perLevel.rows, [{ level_code: 'P1', count: 60 }, { level_code: 'P2', count: 48 }, { level_code: 'P3', count: 48 }]);
  const features = await db().query(`SELECT id FROM spots WHERE (code LIKE '%-01' AND NOT is_accessible) OR (code LIKE '%-02' AND NOT is_ev) OR (code LIKE '%-03' AND NOT is_vip)`);
  assert.equal(features.rowCount, 0);
  assert.equal((await db().query('SELECT 1 FROM spots WHERE id = $1', ['P1-A-01'])).rowCount, 1);
});

test('seed creates buildings, levels and nearby lots', async () => {
  assert.deepEqual((await db().query('SELECT id FROM buildings ORDER BY id')).rows.map(row => row.id), ['biblioteca', 'deportivo', 'ml', 'sd']);
  assert.deepEqual((await db().query('SELECT code, underground FROM levels ORDER BY sort')).rows, [
    { code: 'P1', underground: false }, { code: 'P2', underground: true }, { code: 'P3', underground: true }
  ]);
  assert.equal((await db().query('SELECT 1 FROM nearby_lots')).rowCount, 2);
});
