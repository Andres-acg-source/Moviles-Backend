import { db } from '../db.js';

export async function eventCounts() {
  const { rows } = await db().query<{ name: string; count: number }>('SELECT name, count(*)::int AS count FROM telemetry_events GROUP BY name ORDER BY name');
  return Object.fromEntries(rows.map(row => [row.name, row.count]));
}
