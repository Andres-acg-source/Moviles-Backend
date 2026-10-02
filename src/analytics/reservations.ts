import { db } from '../db.js';

const STATUSES = ['active', 'fulfilled', 'released', 'cancelled', 'expired'] as const;
type Status = (typeof STATUSES)[number];
const empty = () => Object.fromEntries(STATUSES.map(status => [status, 0])) as Record<Status, number>;

export async function reservations() {
  const { rows } = await db().query<{ source: 'user' | 'sim'; status: Status; count: number }>(
    'SELECT source, status, count(*)::int AS count FROM reservations GROUP BY source, status'
  );
  const result = { user: empty(), sim: empty(), total: empty() };
  for (const row of rows) {
    result[row.source][row.status] += row.count;
    result.total[row.status] += row.count;
  }
  return result;
}
