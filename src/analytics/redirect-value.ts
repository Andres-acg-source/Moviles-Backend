import { db } from '../db.js';
import { bogotaLocalSql, DAY_MS } from '../time.js';

export const REDIRECT_DAYS = 28;

interface HourRow {
  lot_id: string;
  name: string;
  hour: number;
  redirects: number;
  answers: number;
  parked: number;
}

interface Counts {
  redirects: number;
  answers: number;
  parked: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const share = (part: number, total: number) => (total ? round(part / total) : null);
const pad = (value: number) => String(value).padStart(2, '0');

export async function redirectValue(now = new Date()) {
  const since = new Date(now.getTime() - REDIRECT_DAYS * DAY_MS);
  const { rows } = await db().query<HourRow>(
    `WITH events AS (
       SELECT name, properties, properties->>'lotId' AS lot_id,
              least(coalesce((properties->>'occurredAt')::timestamptz, created_at), created_at) AS event_at
         FROM telemetry_events
        WHERE name IN ('lot_redirected', 'lot_arrival_confirmed')
          AND properties->>'lotId' IS NOT NULL
     ),
     visits AS (
       SELECT lot_id, event_at AS redirected_at, 1 AS redirects, 0 AS answers, 0 AS parked
         FROM events
        WHERE name = 'lot_redirected'
       UNION ALL
       SELECT lot_id,
              event_at - CASE WHEN jsonb_typeof(properties->'minutesAfter') = 'number'
                              THEN greatest((properties->>'minutesAfter')::float8, 0)
                              ELSE 0
                         END * interval '1 minute',
              0, 1, (properties->>'parked' = 'true')::int
         FROM events
        WHERE name = 'lot_arrival_confirmed'
     )
     SELECT visits.lot_id,
            coalesce(nearby_lots.name, visits.lot_id) AS name,
            extract(hour FROM ${bogotaLocalSql('visits.redirected_at')})::int AS hour,
            sum(visits.redirects)::int AS redirects,
            sum(visits.answers)::int AS answers,
            sum(visits.parked)::int AS parked
       FROM visits
       LEFT JOIN nearby_lots ON nearby_lots.id = visits.lot_id
      WHERE visits.redirected_at >= $1 AND visits.redirected_at < $2
      GROUP BY visits.lot_id, nearby_lots.name, 3
      ORDER BY visits.lot_id, 3`,
    [since, now]
  );

  const lots = new Map<string, Counts & { lotId: string; name: string }>();
  for (const row of rows) {
    const lot = lots.get(row.lot_id) ?? { lotId: row.lot_id, name: row.name, redirects: 0, answers: 0, parked: 0 };
    lot.redirects += row.redirects;
    lot.answers += row.answers;
    lot.parked += row.parked;
    lots.set(row.lot_id, lot);
  }
  const byLot = [...lots.values()]
    .map(lot => {
      const parkedShare = share(lot.parked, lot.answers);
      return { ...lot, parkedShare, estimatedDrivers: parkedShare === null ? null : Math.round(lot.redirects * parkedShare) };
    })
    .sort((a, b) => b.redirects - a.redirects || a.lotId.localeCompare(b.lotId));
  const total = (key: keyof Counts) => byLot.reduce((sum, lot) => sum + lot[key], 0);
  const redirects = total('redirects');
  const answers = total('answers');
  const parked = total('parked');

  return {
    windowDays: REDIRECT_DAYS,
    redirects,
    answers,
    parked,
    answerRate: share(answers, redirects),
    parkedShare: share(parked, answers),
    byLot,
    byLotHour: rows.map(row => ({
      lotId: row.lot_id,
      hour: `${pad(row.hour)}:00`,
      redirects: row.redirects,
      answers: row.answers,
      parked: row.parked,
      parkedShare: share(row.parked, row.answers)
    }))
  };
}
