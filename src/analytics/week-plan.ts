import { db } from '../db.js';
import { weekPredictions } from '../services/predictions.js';
import { bogotaParts, DAY_MS } from '../time.js';

export const WEEK_PLAN_DAYS = 28;
export const NEAR_ARRIVAL_HOURS = 1;

interface Row {
  name: 'week_viewed' | 'week_slot_used';
  platform: string;
  level: string | null;
  arrival_hour: number | null;
  events: number;
}

interface Slot {
  date: string;
  weekday: number;
  hour: number;
  occupancy: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const share = (part: number, total: number) => (total ? round(part / total) : null);
const isHour = (value: number | null): value is number => value !== null && Number.isInteger(value) && value >= 0 && value < 24;

function total(rows: Row[], name: Row['name'], match: (row: Row) => boolean = () => true) {
  return rows.reduce((sum, row) => sum + (row.name === name && match(row) ? row.events : 0), 0);
}

function mostCommon(arrivalHours: { hour: number; views: number }[]) {
  let usual: { hour: number; views: number } | null = null;
  for (const item of arrivalHours) if (!usual || item.views > usual.views) usual = item;
  return usual?.hour ?? null;
}

/**
 * BQ14 (Type 2): which day and hour of the coming week has the lowest predicted occupancy on each level, close to the
 * hour drivers usually arrive. The usual hour is the arrival hour most often set in Plan your week; the best slot of
 * each level is searched from Monday to Friday within one hour of it, or in the whole day when nobody has opened Plan
 * your week yet. Hours of today that already started are left out, as in the app.
 */
export async function weekPlan(now = new Date()) {
  const since = new Date(now.getTime() - WEEK_PLAN_DAYS * DAY_MS);
  const [forecast, { rows }] = await Promise.all([
    weekPredictions(undefined, undefined, now),
    db().query<Row>(
      `WITH events AS (
         SELECT name, properties,
                least(coalesce((properties->>'occurredAt')::timestamptz, created_at), created_at) AS event_at
           FROM telemetry_events
          WHERE name IN ('week_viewed', 'week_slot_used')
       )
       SELECT name,
              coalesce(properties->>'platform', 'unknown') AS platform,
              properties->>'level' AS level,
              CASE WHEN name = 'week_viewed' AND jsonb_typeof(properties->'arrivalHour') = 'number'
                   THEN (properties->>'arrivalHour')::float8
              END AS arrival_hour,
              count(*)::int AS events
         FROM events
        WHERE event_at >= $1 AND event_at < $2
        GROUP BY 1, 2, 3, 4`,
      [since, now]
    )
  ]);

  const views = total(rows, 'week_viewed');
  const slotsUsed = total(rows, 'week_slot_used');
  const arrivalHours = [...new Set(rows.map(row => row.arrival_hour).filter(isHour))]
    .sort((a, b) => a - b)
    .map(hour => ({ hour, views: total(rows, 'week_viewed', row => row.arrival_hour === hour) }));
  const usualArrivalHour = mostCommon(arrivalHours);
  const isNear = (hour: number) => usualArrivalHour === null || Math.abs(hour - usualArrivalHour) <= NEAR_ARRIVAL_HOURS;
  const currentHour = bogotaParts(now).hour;
  const isOpen = (day: { date: string; weekday: number }, hour: number) =>
    day.weekday >= 1 && day.weekday <= 5 && (day.date !== forecast.from || hour > currentHour);

  const byLevel = forecast.levels.map(level => {
    let best: Slot | null = null;
    for (const day of level.days) {
      for (const [index, occupancy] of day.occupancy.entries()) {
        const hour = forecast.hours[index];
        if (occupancy === null || !isNear(hour) || !isOpen(day, hour)) continue;
        if (!best || occupancy < best.occupancy) best = { date: day.date, weekday: day.weekday, hour, occupancy };
      }
    }
    return {
      level: level.code,
      best,
      views: total(rows, 'week_viewed', row => row.level === level.code),
      slotsUsed: total(rows, 'week_slot_used', row => row.level === level.code)
    };
  });

  const platforms = [...new Set(rows.map(row => row.platform))].sort();
  return {
    windowDays: WEEK_PLAN_DAYS,
    from: forecast.from,
    views,
    slotsUsed,
    useRate: share(slotsUsed, views),
    usualArrivalHour,
    nearHours: NEAR_ARRIVAL_HOURS,
    arrivalHours,
    byLevel,
    byPlatform: platforms.map(platform => ({
      platform,
      views: total(rows, 'week_viewed', row => row.platform === platform),
      slotsUsed: total(rows, 'week_slot_used', row => row.platform === platform)
    }))
  };
}
