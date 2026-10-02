import { holdMinutes } from '../config.js';
import { db } from '../db.js';
import { HISTORY_DAYS, slotSql } from '../services/predictions.js';
import { bogotaLocalSql } from '../time.js';

interface GroupRow { level_code: string; slot: string; source: string | null; created: number; fulfilled: number; expired: number; p90: number | null }

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const windowFor = (p90: number | null) => (p90 === null ? null : Math.min(30, Math.max(10, Math.round(p90 / 5) * 5)));

function policy(row: GroupRow | undefined, predictedFree: number | undefined) {
  const created = row?.created ?? 0;
  const expired = row?.expired ?? 0;
  const noShowRate = created ? expired / created : 0;
  const p90 = row?.p90 ?? null;
  const demand = Math.round((created / HISTORY_DAYS) * (1 - noShowRate));
  return {
    created,
    fulfilled: row?.fulfilled ?? 0,
    expired,
    noShowRate: round(noShowRate, 3),
    p90CheckInMinutes: p90 === null ? null : round(p90, 1),
    recommendedWindowMinutes: windowFor(p90),
    heldSpots: predictedFree === undefined ? demand : Math.min(demand, Math.round(predictedFree))
  };
}

export async function reservationPolicy() {
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000);
  const { rows } = await db().query<GroupRow>(
    `WITH recent AS (
       SELECT s.level_code, ${slotSql(bogotaLocalSql('r.created_at'))} AS slot, r.source, r.status, r.checked_in_at,
              extract(epoch FROM r.checked_in_at - r.created_at)::float8 / 60 AS minutes
         FROM reservations r JOIN spots s ON s.id = r.spot_id
        WHERE r.created_at >= $1
     )
     SELECT level_code, slot, CASE WHEN GROUPING(source) = 1 THEN NULL ELSE source END AS source,
            count(*)::int AS created,
            count(*) FILTER (WHERE checked_in_at IS NOT NULL)::int AS fulfilled,
            count(*) FILTER (WHERE status = 'expired')::int AS expired,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes) FILTER (WHERE checked_in_at IS NOT NULL) AS p90
       FROM recent
      GROUP BY GROUPING SETS ((level_code, slot, source), (level_code, slot))
      ORDER BY level_code, slot`,
    [since]
  );
  const free = await db().query<{ level_code: string; slot: string; free: number }>(
    `SELECT level_code, ${slotSql(bogotaLocalSql('taken_at'))} AS slot, avg(free)::float8 AS free
       FROM occupancy_snapshots WHERE taken_at >= $1 GROUP BY 1, 2`,
    [since]
  );
  const predictedFree = new Map(free.rows.map(row => [`${row.level_code}|${row.slot}`, row.free]));
  const groups = new Map<string, Record<string, GroupRow>>();
  for (const row of rows) {
    const key = `${row.level_code}|${row.slot}`;
    groups.set(key, { ...groups.get(key), [row.source ?? 'total']: row });
  }
  return {
    windowDays: HISTORY_DAYS,
    holdMinutes: holdMinutes(),
    rows: [...groups.entries()].map(([key, group]) => {
      const [levelCode, slot] = key.split('|');
      const freeSpots = predictedFree.get(key);
      return { levelCode, slot, user: policy(group.user, freeSpots), sim: policy(group.sim, freeSpots), total: policy(group.total, freeSpots) };
    })
  };
}
