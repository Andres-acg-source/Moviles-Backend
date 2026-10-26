import { holdMinutes } from '../config.js';
import { db } from '../db.js';

export const MIN_RESERVATIONS = 3;
const LATE_PENALTY_MINUTES = 5;

export interface TripRow { status: string; minutes: number | null }

export function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** BQ6 rule for one user: 80th percentile of reserve-to-check-in time, an expired reservation counts as late. */
export function adviceFromTrips(rows: TripRow[], hold: number) {
  if (rows.length < MIN_RESERVATIONS) return null;
  const times = rows.map(row => (row.status === 'expired' ? hold + LATE_PENALTY_MINUTES : Math.max(0, row.minutes ?? 0)));
  const p80 = round1(percentile(times, 0.8)!);
  return {
    p80TravelMinutes: p80,
    expiredCount: rows.filter(row => row.status === 'expired').length,
    suggestedReserveAfterLeavingMinutes: round1(Math.max(0, p80 - hold))
  };
}

export async function leadTime(userId: string) {
  const hold = holdMinutes();
  const { rows } = await db().query<TripRow>(
    `SELECT status, extract(epoch FROM checked_in_at - created_at)::float8 / 60 AS minutes
       FROM reservations
      WHERE user_id = $1 AND source = 'user' AND (checked_in_at IS NOT NULL OR status = 'expired')`,
    [userId]
  );
  const advice = adviceFromTrips(rows, hold);
  if (!advice) {
    return {
      reservationsConsidered: rows.length,
      holdMinutes: hold,
      p80TravelMinutes: null,
      expiredCount: null,
      suggestedReserveAfterLeavingMinutes: null,
      message: `Complete at least ${MIN_RESERVATIONS} reservations to get a personalized suggestion. For now, reserve when you leave.`
    };
  }
  const { p80TravelMinutes: p80, suggestedReserveAfterLeavingMinutes: suggested } = advice;
  return {
    reservationsConsidered: rows.length,
    holdMinutes: hold,
    ...advice,
    message: suggested === 0
      ? `You usually arrive within ${p80} minutes, so you can reserve as soon as you leave and still make the ${hold}-minute hold.`
      : `Your trips take up to ${p80} minutes, so reserve about ${suggested} minutes after leaving to arrive before the ${hold}-minute hold expires.`
  };
}
