import { db } from '../db.js';
import { bogotaDate, bogotaLocalSql, DAY_MS } from '../time.js';

export const FUNNEL_DAYS = 28;
export const FUNNEL_TREND_DAYS = 14;

/** Steps of the reservation flow, in order. The last one comes from the reservations table, not from telemetry. */
export const FUNNEL_STEPS = [
  { key: 'availability_viewed', label: 'Checked availability' },
  { key: 'spot_selected', label: 'Opened a spot' },
  { key: 'reserve_confirm_tapped', label: 'Tapped confirm' },
  { key: 'reservation_created', label: 'Reservation created' }
] as const;

type Counts = { viewed: number; selected: number; confirmed: number; reserved: number };
interface Row extends Counts { day: string; platform: string }

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const rate = (part: number, whole: number) => (whole ? round3(part / whole) : null);
const zero = (): Counts => ({ viewed: 0, selected: 0, confirmed: 0, reserved: 0 });
const add = (into: Counts, row: Counts) => {
  into.viewed += row.viewed;
  into.selected += row.selected;
  into.confirmed += row.confirmed;
  into.reserved += row.reserved;
};

/**
 * BQ7 (Type 3): among users who check live availability, what share completes a reservation and at which step
 * the rest drop off. The unit is one user on one Bogota day, and each step only counts if the previous one happened.
 */
export async function conversionFunnel(now = new Date()) {
  const since = new Date(now.getTime() - FUNNEL_DAYS * DAY_MS);
  const day = (column: string) => `(${bogotaLocalSql(column)})::date`;
  const { rows } = await db().query<Row>(
    `WITH events AS (
       SELECT user_id, ${day('created_at')} AS day, name, properties->>'platform' AS platform
         FROM telemetry_events
        WHERE created_at >= $1 AND user_id IS NOT NULL
          AND name IN ('availability_viewed', 'spot_selected', 'reserve_confirm_tapped')
       UNION ALL
       SELECT user_id, ${day('created_at')}, 'reservation_created', NULL
         FROM reservations
        WHERE source = 'user' AND user_id IS NOT NULL AND created_at >= $1
     ),
     per_day AS (
       SELECT user_id, day,
              coalesce(max(platform) FILTER (WHERE name = 'availability_viewed'), 'unknown') AS platform,
              bool_or(name = 'availability_viewed') AS viewed,
              bool_or(name = 'spot_selected') AS selected,
              bool_or(name = 'reserve_confirm_tapped') AS confirmed,
              bool_or(name = 'reservation_created') AS reserved
         FROM events GROUP BY user_id, day
     )
     SELECT to_char(day, 'YYYY-MM-DD') AS day, platform,
            count(*) FILTER (WHERE viewed)::int AS viewed,
            count(*) FILTER (WHERE viewed AND selected)::int AS selected,
            count(*) FILTER (WHERE viewed AND selected AND confirmed)::int AS confirmed,
            count(*) FILTER (WHERE viewed AND selected AND confirmed AND reserved)::int AS reserved
       FROM per_day GROUP BY day, platform ORDER BY day, platform`,
    [since]
  );
  const failures = await db().query<{ reason: string; count: number }>(
    `SELECT coalesce(properties->>'reason', 'other') AS reason, count(*)::int AS count
       FROM telemetry_events
      WHERE name = 'reserve_failed' AND created_at >= $1
      GROUP BY 1 ORDER BY 2 DESC, 1`,
    [since]
  );

  const total = zero();
  const platforms = new Map<string, Counts>();
  const days = new Map<string, Counts>();
  for (const row of rows) {
    add(total, row);
    add(platforms.get(row.platform) ?? platforms.set(row.platform, zero()).get(row.platform)!, row);
    add(days.get(row.day) ?? days.set(row.day, zero()).get(row.day)!, row);
  }

  const values = [total.viewed, total.selected, total.confirmed, total.reserved];
  const steps = FUNNEL_STEPS.map((step, index) => ({
    ...step,
    count: values[index],
    fromPrevious: index === 0 ? null : rate(values[index], values[index - 1])
  }));
  // The step where the largest share of the remaining users leaves the flow.
  let biggestDrop: { from: string; to: string; lost: number; dropRate: number | null } | null = null;
  for (let index = 1; index < steps.length; index++) {
    const lost = values[index - 1] - values[index];
    const dropRate = rate(lost, values[index - 1]);
    if (lost > 0 && (!biggestDrop || (dropRate ?? 0) > (biggestDrop.dropRate ?? 0))) {
      biggestDrop = { from: steps[index - 1].label, to: steps[index].label, lost, dropRate };
    }
  }

  const daily = Array.from({ length: FUNNEL_TREND_DAYS }, (_, index) => {
    const label = bogotaDate(new Date(now.getTime() - (FUNNEL_TREND_DAYS - 1 - index) * DAY_MS));
    const counts = days.get(label) ?? zero();
    return { day: label, viewed: counts.viewed, reserved: counts.reserved, conversionRate: rate(counts.reserved, counts.viewed) };
  });

  return {
    windowDays: FUNNEL_DAYS,
    unit: 'user-day',
    steps,
    conversionRate: rate(total.reserved, total.viewed),
    biggestDrop,
    byPlatform: [...platforms.entries()].map(([platform, counts]) => ({ platform, ...counts, conversionRate: rate(counts.reserved, counts.viewed) })),
    failures: failures.rows,
    daily
  };
}
