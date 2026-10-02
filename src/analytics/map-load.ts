import { db } from '../db.js';

const round = (value: number | null, digits: number) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

export async function mapLoad() {
  const { rows } = await db().query<{ deviceModel: string; osVersion: string; levelCode: string; loads: number; avgMs: number | null; p90Ms: number | null; failures: number }>(
    `WITH loads AS (
       SELECT coalesce(properties->>'deviceModel', 'unknown') AS device_model,
              coalesce(properties->>'osVersion', 'unknown') AS os_version,
              coalesce(properties->>'levelCode', 'unknown') AS level_code,
              CASE WHEN jsonb_typeof(properties->'durationMs') = 'number' THEN (properties->>'durationMs')::float8 END AS duration_ms,
              properties->>'success' = 'false' AS failed
         FROM telemetry_events WHERE name = 'map_loaded'
     )
     SELECT device_model AS "deviceModel", os_version AS "osVersion", level_code AS "levelCode",
            count(*)::int AS loads,
            avg(duration_ms) AS "avgMs",
            percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) AS "p90Ms",
            count(*) FILTER (WHERE failed)::int AS failures
       FROM loads GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`
  );
  return rows.map(({ failures, ...row }) => ({ ...row, avgMs: round(row.avgMs, 1), p90Ms: round(row.p90Ms, 1), failureRate: round(failures / row.loads, 3) }));
}
