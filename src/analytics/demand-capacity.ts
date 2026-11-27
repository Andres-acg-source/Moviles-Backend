import { db } from '../db.js';
import { WEEK_HOURS } from '../services/predictions.js';
import { bogotaLocalSql, DAY_MS } from '../time.js';

export const DEMAND_CAPACITY_DAYS = 28;

interface Row {
  level: string;
  weekday: number;
  hour: number;
  served: number;
  unmet: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const snapshotAt = bogotaLocalSql('taken_at');
const unmetAt = bogotaLocalSql('slot_start');

export async function demandCapacity(now = new Date()) {
  const since = new Date(now.getTime() - DEMAND_CAPACITY_DAYS * DAY_MS);
  const [{ rows }, levels] = await Promise.all([
    db().query<Row>(
      `WITH served AS (
         SELECT level_code, ${snapshotAt}::date AS day, extract(hour FROM ${snapshotAt})::int AS hour,
                max(occupied + reserved) AS busy
           FROM occupancy_snapshots
          WHERE taken_at >= $1 AND taken_at < $2 AND extract(hour FROM ${snapshotAt}) BETWEEN $3 AND $4
          GROUP BY 1, 2, 3
       ), unmet AS (
         SELECT ${unmetAt}::date AS day, extract(hour FROM ${unmetAt})::int AS hour, count(*) AS queries
           FROM unmet_demand
          WHERE slot_start >= $1 AND slot_start < $2
          GROUP BY 1, 2
       )
       SELECT s.level_code AS level, extract(dow FROM s.day)::int AS weekday, s.hour,
              avg(s.busy)::float8 AS served, avg(coalesce(u.queries, 0))::float8 AS unmet
         FROM served s
         LEFT JOIN unmet u ON u.day = s.day AND u.hour = s.hour
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3`,
      [since, now, WEEK_HOURS[0], WEEK_HOURS.at(-1)]
    ),
    db().query<{ code: string; capacity: number }>(
      `SELECT l.code, count(s.id) FILTER (WHERE s.status <> 'disabled')::int AS capacity
         FROM levels l LEFT JOIN spots s ON s.level_code = l.code
        GROUP BY l.code, l.sort
        ORDER BY l.sort`
    )
  ]);

  const campus = levels.rows.reduce((sum, level) => sum + level.capacity, 0);
  const byLevel = levels.rows.map(({ code, capacity }) => {
    const share = campus ? capacity / campus : 0;
    const slots = rows.filter(row => row.level === code).map(row => {
      const demand = row.served + row.unmet * share;
      const ratio = capacity ? round(demand / capacity) : null;
      return { weekday: row.weekday, hour: row.hour, demand: round(demand), ratio, over: ratio !== null && ratio > 1 };
    });
    return { code, capacity, slots, overSlots: slots.filter(slot => slot.over).length };
  });

  let worst: { level: string; weekday: number; hour: number; ratio: number } | null = null;
  for (const level of byLevel) {
    for (const slot of level.slots) {
      if (slot.ratio !== null && (!worst || slot.ratio > worst.ratio)) {
        worst = { level: level.code, weekday: slot.weekday, hour: slot.hour, ratio: slot.ratio };
      }
    }
  }

  return { windowDays: DEMAND_CAPACITY_DAYS, hours: WEEK_HOURS, levels: byLevel, worst };
}
