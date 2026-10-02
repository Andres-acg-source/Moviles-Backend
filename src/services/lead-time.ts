import { holdMinutes } from '../config.js';
import { db } from '../db.js';

const MIN_RESERVATIONS = 3;
const LATE_PENALTY_MINUTES = 5;

export function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export async function leadTime(userId: string) {
  const hold = holdMinutes();
  const { rows } = await db().query<{ status: string; minutes: number | null }>(
    `SELECT status, extract(epoch FROM checked_in_at - created_at)::float8 / 60 AS minutes
       FROM reservations
      WHERE user_id = $1 AND source = 'user' AND (checked_in_at IS NOT NULL OR status = 'expired')`,
    [userId]
  );
  if (rows.length < MIN_RESERVATIONS) {
    return {
      reservationsConsidered: rows.length,
      holdMinutes: hold,
      p80TravelMinutes: null,
      expiredCount: null,
      suggestedReserveAfterLeavingMinutes: null,
      message: `Complete at least ${MIN_RESERVATIONS} reservations to get a personalized suggestion. For now, reserve when you leave.`
    };
  }
  const times = rows.map(row => (row.status === 'expired' ? hold + LATE_PENALTY_MINUTES : Math.max(0, row.minutes ?? 0)));
  const p80 = round1(percentile(times, 0.8)!);
  const suggested = round1(Math.max(0, p80 - hold));
  return {
    reservationsConsidered: rows.length,
    holdMinutes: hold,
    p80TravelMinutes: p80,
    expiredCount: rows.filter(row => row.status === 'expired').length,
    suggestedReserveAfterLeavingMinutes: suggested,
    message: suggested === 0
      ? `You usually arrive within ${p80} minutes, so you can reserve as soon as you leave and still make the ${hold}-minute hold.`
      : `Your trips take up to ${p80} minutes, so reserve about ${suggested} minutes after leaving to arrive before the ${hold}-minute hold expires.`
  };
}
