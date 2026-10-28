import { db } from '../db.js';
import { HISTORY_DAYS, slotSql } from '../services/predictions.js';
import { bogotaLocalSql, DAY_MS } from '../time.js';

export const ACCURACY_DAYS = 7;

interface LevelRow {
  level: string;
  samples: number;
  predicted_avg: number;
  real_avg: number;
  mean_abs_error: number;
}

interface PlatformRow {
  platform: string;
  views: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export async function predictionAccuracy(now = new Date()) {
  const since = new Date(now.getTime() - ACCURACY_DAYS * DAY_MS);
  const historySince = new Date(since.getTime() - (HISTORY_DAYS + 1) * DAY_MS);
  const local = bogotaLocalSql('taken_at');
  const eventAt = `least(coalesce((properties->>'occurredAt')::timestamptz, created_at), created_at)`;

  const [levels, views] = await Promise.all([
    db().query<LevelRow>(
      `WITH snapshots AS (
         SELECT level_code, taken_at, (${local})::date AS day, ${slotSql(local)} AS slot,
                (occupied + reserved)::float8 / nullif(total, 0) AS occupancy
           FROM occupancy_snapshots
          WHERE taken_at >= $1 AND taken_at < $3
       ),
       history AS (
         SELECT level_code, day, slot, sum(occupancy) AS occupancy_sum, count(occupancy) AS occupancy_count
           FROM snapshots
          GROUP BY level_code, day, slot
       ),
       scored AS (
         SELECT recent.level_code, recent.occupancy AS real,
                sum(history.occupancy_sum) / nullif(sum(history.occupancy_count), 0) AS predicted
           FROM snapshots recent
           LEFT JOIN history
             ON history.level_code = recent.level_code
            AND history.slot = recent.slot
            AND history.day >= recent.day - $4::int
            AND history.day < recent.day
            AND extract(dow FROM history.day) = extract(dow FROM recent.day)
          WHERE recent.taken_at >= $2 AND recent.occupancy IS NOT NULL
          GROUP BY recent.level_code, recent.taken_at, recent.occupancy
       )
       SELECT level_code AS level,
              count(*)::int AS samples,
              avg(predicted) AS predicted_avg,
              avg(real) AS real_avg,
              avg(abs(real - predicted)) AS mean_abs_error
         FROM scored
        WHERE predicted IS NOT NULL
        GROUP BY level_code
        ORDER BY level_code`,
      [historySince, since, now, HISTORY_DAYS]
    ),
    db().query<PlatformRow>(
      `SELECT coalesce(properties->>'platform', 'unknown') AS platform, count(*)::int AS views
         FROM telemetry_events
        WHERE name = 'forecast_viewed' AND ${eventAt} >= $1 AND ${eventAt} < $2
        GROUP BY 1
        ORDER BY views DESC, platform`,
      [since, now]
    )
  ]);

  const samples = levels.rows.reduce((total, row) => total + row.samples, 0);
  const errorSum = levels.rows.reduce((total, row) => total + row.mean_abs_error * row.samples, 0);

  return {
    windowDays: ACCURACY_DAYS,
    forecastViews: {
      total: views.rows.reduce((total, row) => total + row.views, 0),
      byPlatform: views.rows
    },
    byLevel: levels.rows.map(row => ({
      level: row.level,
      samples: row.samples,
      predictedAvg: round(row.predicted_avg),
      realAvg: round(row.real_avg),
      meanAbsError: round(row.mean_abs_error)
    })),
    overall: {
      samples,
      meanAbsError: samples ? round(errorSum / samples) : null
    }
  };
}
