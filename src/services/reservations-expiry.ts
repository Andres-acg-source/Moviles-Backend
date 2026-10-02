import { db, type Db } from '../db.js';

export async function expireReservations(client: Db = db()) {
  const { rows } = await client.query<{ expired: number; freed: number }>(
    `WITH expired AS (
       UPDATE reservations SET status = 'expired'
        WHERE status = 'active' AND expires_at < now()
        RETURNING spot_id
     ), freed AS (
       UPDATE spots s SET status = 'free', held_by = NULL, source = NULL, updated_at = now()
         FROM expired e
        WHERE s.id = e.spot_id AND s.status = 'reserved'
        RETURNING s.id
     )
     SELECT (SELECT count(*) FROM expired)::int AS expired, (SELECT count(*) FROM freed)::int AS freed`
  );
  return rows[0];
}
