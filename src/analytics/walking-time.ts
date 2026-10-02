import { db } from '../db.js';

const round1 = (value: number) => Math.round(value * 10) / 10;

export async function walkingTime() {
  const { rows } = await db().query<{ level: string; views: number; total: number }>(
    `SELECT coalesce(properties->>'levelCode', 'unknown') AS level, count(*)::int AS views, sum((properties->>'minutes')::float8) AS total
       FROM telemetry_events
      WHERE name = 'walking_time_viewed' AND jsonb_typeof(properties->'minutes') = 'number'
      GROUP BY 1 ORDER BY 1`
  );
  const views = rows.reduce((sum, row) => sum + row.views, 0);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return {
    views,
    averageMinutes: views ? round1(total / views) : 0,
    byLevel: Object.fromEntries(rows.map(row => [row.level, { views: row.views, averageMinutes: round1(row.total / row.views) }]))
  };
}
