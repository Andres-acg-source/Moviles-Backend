import { withTransaction } from '../db.js';

export async function clearSimulatedOccupancy() {
  return withTransaction(async client => {
    await client.query(
      `UPDATE reservations SET status = 'released', released_at = now()
        WHERE source = 'sim' AND (status = 'active' OR (status = 'fulfilled' AND released_at IS NULL))`
    );
    const { rowCount } = await client.query(
      `UPDATE spots SET status = 'free', held_by = NULL, source = NULL, updated_at = now()
        WHERE source = 'sim' AND status IN ('occupied', 'reserved')`
    );
    return rowCount ?? 0;
  });
}
