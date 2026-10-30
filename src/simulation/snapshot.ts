import { db } from '../db.js';

export async function recordSnapshot(slot: Date) {
  await db().query(
    `INSERT INTO occupancy_snapshots (level_code, taken_at, total, free, reserved, occupied, source)
     SELECT l.code, $1,
            count(s.id) FILTER (WHERE s.status <> 'disabled'),
            count(s.id) FILTER (WHERE s.status = 'free'),
            count(s.id) FILTER (WHERE s.status = 'reserved'),
            count(s.id) FILTER (WHERE s.status = 'occupied'),
            'sim'
       FROM levels l LEFT JOIN spots s ON s.level_code = l.code
      GROUP BY l.code
     ON CONFLICT (level_code, taken_at) DO NOTHING`,
    [slot]
  );
}
