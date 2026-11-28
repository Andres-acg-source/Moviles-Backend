import { db } from '../db.js';
import { DAY_MS } from '../time.js';

export const VOICE_DAYS = 28;
export const VOICE_DEVICE_LIMIT = 10;

interface Metrics {
  attempts: number;
  failures: number;
  medianMs: number | null;
  p90Ms: number | null;
}

const round = (value: number | null, digits: number) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const share = (part: number, total: number) => (total ? round(part / total, 3) : null);

const attemptEvents = `
  WITH attempts AS (
    SELECT coalesce(properties->>'outcome', 'unknown') AS outcome,
           coalesce(properties->>'platform', 'unknown') AS platform,
           coalesce(nullif(properties->>'deviceModel', ''), 'unknown') AS device_model,
           coalesce(nullif(properties->>'osVersion', ''), 'unknown') AS os_version,
           coalesce(nullif(properties->>'level', ''), 'none') AS level,
           CASE WHEN jsonb_typeof(properties->'latencyMs') = 'number' THEN (properties->>'latencyMs')::float8 END AS latency
      FROM telemetry_events
     WHERE name = 'voice_recognition'
       AND least(coalesce((properties->>'occurredAt')::timestamptz, created_at), created_at) >= $1
       AND least(coalesce((properties->>'occurredAt')::timestamptz, created_at), created_at) < $2
  )`;

const aggregates = `
  count(*)::int AS attempts,
  count(*) FILTER (WHERE outcome <> 'ok')::int AS failures,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency) FILTER (WHERE outcome = 'ok') AS "medianMs",
  percentile_cont(0.9) WITHIN GROUP (ORDER BY latency) FILTER (WHERE outcome = 'ok') AS "p90Ms"`;

const timing = ({ attempts, failures, medianMs, p90Ms }: Metrics) => ({
  attempts,
  medianMs: round(medianMs, 1),
  p90Ms: round(p90Ms, 1),
  failureRate: share(failures, attempts)
});

export async function voiceRecognition(now = new Date()) {
  const since = new Date(now.getTime() - VOICE_DAYS * DAY_MS);
  const params = [since, now];
  const [totals, outcomes, platforms, devices, levels] = await Promise.all([
    db().query<Metrics>(`${attemptEvents} SELECT ${aggregates} FROM attempts`, params),
    db().query<{ outcome: string; attempts: number }>(
      `${attemptEvents}
       SELECT outcome, count(*)::int AS attempts FROM attempts
        GROUP BY outcome ORDER BY attempts DESC, outcome COLLATE "C"`,
      params
    ),
    db().query<Metrics & { platform: string }>(
      `${attemptEvents}
       SELECT platform, ${aggregates} FROM attempts
        GROUP BY platform ORDER BY platform COLLATE "C"`,
      params
    ),
    db().query<Metrics & { platform: string; deviceModel: string; osVersion: string }>(
      `${attemptEvents}
       SELECT platform, device_model AS "deviceModel", os_version AS "osVersion", ${aggregates} FROM attempts
        GROUP BY platform, device_model, os_version
        ORDER BY attempts DESC, platform COLLATE "C", device_model COLLATE "C", os_version COLLATE "C"
        LIMIT ${VOICE_DEVICE_LIMIT}`,
      params
    ),
    db().query<Metrics & { level: string }>(
      `${attemptEvents}
       SELECT level, ${aggregates} FROM attempts
        GROUP BY level ORDER BY level = 'none', level COLLATE "C"`,
      params
    )
  ]);

  const overall = timing(totals.rows[0]);
  return {
    windowDays: VOICE_DAYS,
    attempts: overall.attempts,
    failures: totals.rows[0].failures,
    failureRate: overall.failureRate,
    medianMs: overall.medianMs,
    p90Ms: overall.p90Ms,
    byOutcome: outcomes.rows.map(row => ({ outcome: row.outcome, attempts: row.attempts, share: share(row.attempts, overall.attempts) })),
    byPlatform: platforms.rows.map(({ platform, ...row }) => ({ platform, ...timing(row) })),
    byDevice: devices.rows.map(({ platform, deviceModel, osVersion, ...row }) => ({ platform, deviceModel, osVersion, ...timing(row) })),
    byLevel: levels.rows.map(row => ({ level: row.level, attempts: row.attempts, failureRate: share(row.failures, row.attempts) }))
  };
}
