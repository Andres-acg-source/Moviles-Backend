import { db } from '../db.js';
import { bogotaMonthLabel, bogotaMonthStart } from '../time.js';

export const FILTERS = ['available', 'vip', 'electric', 'accessible'] as const;

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

export async function filterUsage(now = new Date()) {
  const since = bogotaMonthStart(now);
  const active = await db().query<{ count: number }>(
    `SELECT count(DISTINCT user_id)::int AS count FROM telemetry_events WHERE name = 'app_opened' AND created_at >= $1 AND user_id IS NOT NULL`,
    [since]
  );
  const { rows } = await db().query<{ filter: string; uses: number; activeUsersUsing: number }>(
    `WITH active AS (
       SELECT DISTINCT user_id FROM telemetry_events WHERE name = 'app_opened' AND created_at >= $1 AND user_id IS NOT NULL
     )
     SELECT properties->>'filter' AS filter, count(*)::int AS uses,
            count(DISTINCT user_id) FILTER (WHERE user_id IN (SELECT user_id FROM active))::int AS "activeUsersUsing"
       FROM telemetry_events
      WHERE name = 'filter_applied' AND created_at >= $1 AND properties->>'filter' = ANY($2)
      GROUP BY 1`,
    [since, FILTERS]
  );
  const activeUsers = active.rows[0].count;
  const byFilter = new Map(rows.map(row => [row.filter, row]));
  return {
    month: bogotaMonthLabel(now),
    activeUsers,
    filters: Object.fromEntries(FILTERS.map(filter => {
      const row = byFilter.get(filter);
      const uses = row?.uses ?? 0;
      return [filter, {
        uses,
        usesPerActiveUser: activeUsers ? round(uses / activeUsers, 2) : null,
        percentNeverUsed: activeUsers ? round(((activeUsers - (row?.activeUsersUsing ?? 0)) / activeUsers) * 100, 1) : null
      }];
    }))
  };
}
