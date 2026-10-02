import type pg from 'pg';
import { holdMinutes } from '../config.js';
import { withTransaction } from '../db.js';
import { DAY_MS, SLOT_MINUTES, slotStart } from '../time.js';
import { CHECK_IN_PROBABILITY, checkInDelayMinutes, stayMinutes } from './driver-plan.js';
import { baseOccupancy, targetOccupancy } from './profile.js';

const HISTORY_LOCK = 727_274_003;
const HISTORY_DAYS = 28;
const RESERVED_SHARE = 0.05;
const SIM_RESERVATIONS_PER_MINUTE = 0.15;
const COMPLETED_BEFORE_MS = 5 * 3_600_000;
const BATCH = 4000;
const SLOT_MS = SLOT_MINUTES * 60_000;

async function insertBatches(client: pg.PoolClient, sql: string, columns: unknown[][]) {
  const length = columns[0].length;
  for (let start = 0; start < length; start += BATCH) {
    await client.query(sql, columns.map(column => column.slice(start, start + BATCH)));
  }
}

export async function ensureHistory(options: { now?: Date; random?: () => number } = {}) {
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const hold = holdMinutes();
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [HISTORY_LOCK]);
    const existing = await client.query('SELECT 1 FROM occupancy_snapshots LIMIT 1');
    if (existing.rowCount) return false;
    const { rows: levels } = await client.query<{ code: string; total: number; spots: string[] }>(
      `SELECT l.code, count(s.id) FILTER (WHERE s.status <> 'disabled')::int AS total,
              coalesce(array_agg(s.id) FILTER (WHERE s.status <> 'disabled'), '{}') AS spots
         FROM levels l LEFT JOIN spots s ON s.level_code = l.code GROUP BY l.code, l.sort ORDER BY l.sort`
    );
    const snapshots: unknown[][] = [[], [], [], [], [], []];
    const reservations: unknown[][] = [[], [], [], [], [], []];
    const end = slotStart(now).getTime();
    for (let time = end - HISTORY_DAYS * DAY_MS; time <= end; time += SLOT_MS) {
      const slot = new Date(time);
      for (const level of levels) {
        const busy = Math.round(targetOccupancy(level.code, slot, random) * level.total);
        const reserved = Math.round(busy * RESERVED_SHARE);
        [level.code, slot, level.total, level.total - busy, reserved, busy - reserved].forEach((value, index) => snapshots[index].push(value));
        if (time > now.getTime() - COMPLETED_BEFORE_MS || !level.spots.length) continue;
        const expected = baseOccupancy(level.code, slot) * SIM_RESERVATIONS_PER_MINUTE * SLOT_MINUTES;
        const count = Math.floor(expected) + (random() < expected % 1 ? 1 : 0);
        for (let index = 0; index < count; index++) {
          const created = time + random() * SLOT_MS;
          const spot = level.spots[Math.floor(random() * level.spots.length)];
          const arrived = random() < CHECK_IN_PROBABILITY;
          const checkedIn = arrived ? created + checkInDelayMinutes(random(), hold) * 60_000 : null;
          const released = checkedIn ? checkedIn + stayMinutes(random()) * 60_000 : null;
          [spot, arrived ? 'released' : 'expired', new Date(created), new Date(created + hold * 60_000), checkedIn && new Date(checkedIn), released && new Date(released)]
            .forEach((value, position) => reservations[position].push(value));
        }
      }
    }
    await insertBatches(client,
      `INSERT INTO occupancy_snapshots (level_code, taken_at, total, free, reserved, occupied, source)
       SELECT *, 'sim' FROM unnest($1::text[], $2::timestamptz[], $3::int[], $4::int[], $5::int[], $6::int[])`,
      snapshots);
    if (reservations[0].length) {
      await insertBatches(client,
        `INSERT INTO reservations (user_id, spot_id, source, status, created_at, expires_at, checked_in_at, released_at)
         SELECT NULL, spot, 'sim', status, created, expires, checked_in, released
           FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[], $5::timestamptz[], $6::timestamptz[])
             AS t(spot, status, created, expires, checked_in, released)`,
        reservations);
    }
    return true;
  });
}
