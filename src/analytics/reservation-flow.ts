import { db } from '../db.js';

interface FlowRow {
  deviceModel: string;
  osVersion: string;
  requests: number;
  failures: number;
  medianMs: number | null;
  p90Ms: number | null;
  opens: number;
  crashes: number;
}

const round = (value: number | null, digits: number) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const ratio = (part: number, total: number) => (total === 0 ? null : round(part / total, 3));
const per100 = (part: number, total: number) => (total === 0 ? null : round((part / total) * 100, 1));

function metrics({ requests, failures, medianMs, p90Ms, opens, crashes }: Omit<FlowRow, 'deviceModel' | 'osVersion'>) {
  return {
    requests,
    medianMs: round(medianMs, 1),
    p90Ms: round(p90Ms, 1),
    failureRate: ratio(failures, requests),
    opens,
    crashes,
    crashesPer100Opens: per100(crashes, opens)
  };
}

const flowEvents = `
  WITH flow AS (
    SELECT name,
           coalesce(properties->>'deviceModel', 'unknown') AS device_model,
           coalesce(properties->>'osVersion', 'unknown') AS os_version,
           CASE WHEN jsonb_typeof(properties->'durationMs') = 'number' THEN (properties->>'durationMs')::float8 END AS duration_ms,
           properties->>'success' = 'false' AS failed,
           properties->>'errorType' AS error_type
      FROM telemetry_events
     WHERE name IN ('reservation_request', 'reserve_opened')
        OR (name = 'app_crash' AND properties->>'inReservationFlow' = 'true')
  )`;

const aggregates = `
  count(*) FILTER (WHERE name = 'reservation_request')::int AS requests,
  count(*) FILTER (WHERE name = 'reservation_request' AND failed)::int AS failures,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE name = 'reservation_request') AS "medianMs",
  percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE name = 'reservation_request') AS "p90Ms",
  count(*) FILTER (WHERE name = 'reserve_opened')::int AS opens,
  count(*) FILTER (WHERE name = 'app_crash')::int AS crashes`;

export async function reservationFlow() {
  const [byDevice, totals, errors] = await Promise.all([
    db().query<FlowRow>(
      `${flowEvents}
       SELECT device_model AS "deviceModel", os_version AS "osVersion", ${aggregates}
         FROM flow GROUP BY 1, 2 ORDER BY 1, 2`
    ),
    db().query<Omit<FlowRow, 'deviceModel' | 'osVersion'>>(`${flowEvents} SELECT ${aggregates} FROM flow`),
    db().query<{ errorType: string; count: number }>(
      `${flowEvents}
       SELECT coalesce(error_type, 'unknown') AS "errorType", count(*)::int AS count
         FROM flow WHERE name = 'reservation_request' AND failed
        GROUP BY 1 ORDER BY 2 DESC, 1`
    )
  ]);
  return {
    totals: metrics(totals.rows[0]),
    byDevice: byDevice.rows.map(({ deviceModel, osVersion, ...row }) => ({ deviceModel, osVersion, ...metrics(row) })),
    errors: Object.fromEntries(errors.rows.map(row => [row.errorType, row.count]))
  };
}
