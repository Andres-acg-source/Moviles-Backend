import { holdMinutes } from '../config.js';
import { db } from '../db.js';
import { adviceFromTrips, MIN_RESERVATIONS, percentile, type TripRow } from '../services/lead-time.js';

const BUCKETS = [
  { label: 'Reserve when leaving', min: 0, max: 0 },
  { label: '1 to 5 min after leaving', min: 0.1, max: 5 },
  { label: '6 to 10 min after leaving', min: 5.1, max: 10 },
  { label: '11 to 15 min after leaving', min: 10.1, max: 15 },
  { label: 'More than 15 min after leaving', min: 15.1, max: Infinity }
];

const round1 = (value: number) => Math.round(value * 10) / 10;

/** BQ6 seen by the team: how the personal advice is distributed across users. */
export async function leadTimeOverview() {
  const hold = holdMinutes();
  const { rows } = await db().query<TripRow & { user_id: string }>(
    `SELECT user_id, status, extract(epoch FROM checked_in_at - created_at)::float8 / 60 AS minutes
       FROM reservations
      WHERE source = 'user' AND user_id IS NOT NULL AND (checked_in_at IS NOT NULL OR status = 'expired')`
  );
  const byUser = new Map<string, TripRow[]>();
  for (const row of rows) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);

  const advice = [...byUser.values()].map(trips => adviceFromTrips(trips, hold)).filter(value => value !== null);
  const counts = BUCKETS.map(() => 0);
  for (const { suggestedReserveAfterLeavingMinutes: minutes } of advice) {
    const index = BUCKETS.findIndex(bucket => minutes >= bucket.min && minutes <= bucket.max);
    counts[index === -1 ? counts.length - 1 : index] += 1;
  }
  const median = percentile(advice.map(value => value.p80TravelMinutes), 0.5);
  return {
    holdMinutes: hold,
    minReservations: MIN_RESERVATIONS,
    usersWithAdvice: advice.length,
    usersWithoutEnoughTrips: byUser.size - advice.length,
    medianP80TravelMinutes: median === null ? null : round1(median),
    expiredShare: rows.length ? Math.round((rows.filter(row => row.status === 'expired').length / rows.length) * 1000) / 1000 : null,
    buckets: BUCKETS.map((bucket, index) => ({ label: bucket.label, users: counts[index] }))
  };
}
