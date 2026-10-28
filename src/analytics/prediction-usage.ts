import { db } from '../db.js';
import { bogotaLocalSql } from '../time.js';

interface UsageRow {
  forecast_day: boolean;
  sessions: number;
  parked: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export async function predictionUsage() {
  const { rows } = await db().query<UsageRow>(
    `WITH events AS (
       SELECT user_id, name, properties,
              least(coalesce((properties->>'occurredAt')::timestamptz, created_at), created_at) AS event_at
         FROM telemetry_events
        WHERE user_id IS NOT NULL
          AND name IN ('forecast_viewed', 'availability_viewed', 'map_loaded')
     ),
     daily_events AS (
       SELECT user_id,
              ${bogotaLocalSql('event_at')}::date AS activity_day,
              min(event_at) FILTER (WHERE name = 'forecast_viewed') AS forecast_at,
              min(event_at) FILTER (
                WHERE name = 'availability_viewed'
                   OR (name = 'map_loaded' AND properties->>'success' = 'true')
              ) AS availability_at
         FROM events
        GROUP BY user_id, ${bogotaLocalSql('event_at')}::date
       HAVING count(*) FILTER (WHERE name = 'forecast_viewed') > 0
           OR count(*) FILTER (
                WHERE name = 'availability_viewed'
                   OR (name = 'map_loaded' AND properties->>'success' = 'true')
              ) > 0
     ),
     sessions AS (
       SELECT user_id, activity_day,
              (forecast_at IS NOT NULL AND (availability_at IS NULL OR forecast_at < availability_at)) AS forecast_day
         FROM daily_events
     ),
     parked_days AS (
       SELECT user_id, ${bogotaLocalSql('checked_in_at')}::date AS activity_day
         FROM reservations
        WHERE source = 'user' AND user_id IS NOT NULL AND checked_in_at IS NOT NULL
        GROUP BY user_id, ${bogotaLocalSql('checked_in_at')}::date
     )
     SELECT sessions.forecast_day,
            count(*)::int AS sessions,
            count(*) FILTER (WHERE parked_days.user_id IS NOT NULL)::int AS parked
       FROM sessions
       LEFT JOIN parked_days USING (user_id, activity_day)
      GROUP BY sessions.forecast_day`
  );
  const forecast = rows.find(row => row.forecast_day);
  const liveOnly = rows.find(row => !row.forecast_day);
  const forecastSessions = forecast?.sessions ?? 0;
  const liveOnlySessions = liveOnly?.sessions ?? 0;
  const totalSessions = forecastSessions + liveOnlySessions;
  const forecastParkingRate = forecastSessions ? round((forecast?.parked ?? 0) / forecastSessions) : null;
  const liveOnlyParkingRate = liveOnlySessions ? round((liveOnly?.parked ?? 0) / liveOnlySessions) : null;

  return {
    totalSessions,
    forecastSessions,
    liveOnlySessions,
    forecastShare: totalSessions ? round(forecastSessions / totalSessions) : null,
    forecastParkingRate,
    liveOnlyParkingRate,
    parkingRateDifference: forecastParkingRate === null || liveOnlyParkingRate === null
      ? null
      : round(forecastParkingRate - liveOnlyParkingRate)
  };
}
