import { db } from '../db.js';

export async function parking() {
  const { rows } = await db().query<{ total: number; free: number; reserved: number; occupied: number; accessibleFree: number; evFree: number }>(
    `SELECT count(*) FILTER (WHERE status <> 'disabled')::int AS total,
            count(*) FILTER (WHERE status = 'free')::int AS free,
            count(*) FILTER (WHERE status = 'reserved')::int AS reserved,
            count(*) FILTER (WHERE status = 'occupied')::int AS occupied,
            count(*) FILTER (WHERE status = 'free' AND is_accessible)::int AS "accessibleFree",
            count(*) FILTER (WHERE status = 'free' AND is_ev)::int AS "evFree"
       FROM spots`
  );
  return rows[0];
}
