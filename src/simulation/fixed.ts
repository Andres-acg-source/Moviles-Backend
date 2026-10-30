import { isTest } from '../config.js';
import { db, withTransaction } from '../db.js';
import { expireReservations } from '../services/reservations-expiry.js';
import { slotStart } from '../time.js';
import type { OccupancySource } from './occupancy-source.js';
import { scenarioFor } from './scenarios.js';
import { recordSnapshot } from './snapshot.js';

const TICK_MS = 60_000;

// Share of the usable spots of each level kept occupied. The same spots are picked every time,
// so the map does not move by itself and only ParkWise users change the counts.
export const FIXED_OCCUPANCY: Record<string, number> = { P1: 0.75, P2: 0.8, P3: 0.7 };
const DEFAULT_SHARE = 0.75;

const OPEN_USER_RESERVATION = `EXISTS (
  SELECT 1 FROM reservations r
   WHERE r.spot_id = s.id AND r.source = 'user'
     AND (r.status = 'active' OR (r.status = 'fulfilled' AND r.released_at IS NULL)))`;

export class FixedOccupancySource implements OccupancySource {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private lastSnapshotSlot?: number;
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  start() {
    if (isTest() || this.timer) return;
    const run = () => this.tick().catch(error => console.error('[fixed] tick failed:', error instanceof Error ? error.message : error));
    void run();
    this.timer = setInterval(run, TICK_MS);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  tick() {
    const previous = this.running ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.runTick());
    this.running = current;
    return current;
  }

  private async runTick() {
    const now = this.now();
    await expireReservations();
    await this.applyLayout(now);
    const slot = slotStart(now);
    if (this.lastSnapshotSlot === slot.getTime()) return;
    await recordSnapshot(slot);
    this.lastSnapshotSlot = slot.getTime();
  }

  private async applyLayout(now: Date) {
    const { rows: levels } = await db().query<{ code: string }>('SELECT code FROM levels ORDER BY sort');
    const codes = levels.map(level => level.code);
    const shares = codes.map(code => scenarioFor(code, now) ?? FIXED_OCCUPANCY[code] ?? DEFAULT_SHARE);
    await withTransaction(async client => {
      await client.query(
        `UPDATE reservations SET status = 'released', released_at = now()
          WHERE source = 'sim' AND (status = 'active' OR (status = 'fulfilled' AND released_at IS NULL))`
      );
      const { rows } = await client.query<{ id: string }>(
        `WITH wanted AS (
           SELECT t.code, round(t.share * count(s.id) FILTER (WHERE s.status <> 'disabled'))::int AS spots
             FROM unnest($1::text[], $2::float8[]) AS t(code, share)
             JOIN spots s ON s.level_code = t.code
            GROUP BY t.code, t.share
         ),
         ranked AS (
           SELECT s.id, s.level_code, row_number() OVER (PARTITION BY s.level_code ORDER BY md5(s.id)) AS rank
             FROM spots s
            WHERE s.status <> 'disabled' AND s.held_by IS NULL AND s.source IS DISTINCT FROM 'user'
              AND NOT ${OPEN_USER_RESERVATION}
         )
         SELECT ranked.id FROM ranked JOIN wanted ON wanted.code = ranked.level_code
          WHERE ranked.rank <= wanted.spots`,
        [codes, shares]
      );
      const ids = rows.map(row => row.id);
      await client.query(
        `UPDATE spots SET status = 'occupied', source = 'sim', updated_at = now()
          WHERE id = ANY($1) AND held_by IS NULL AND (status = 'free' OR (status = 'reserved' AND source = 'sim'))`,
        [ids]
      );
      await client.query(
        `UPDATE spots SET status = 'free', source = NULL, updated_at = now()
          WHERE source = 'sim' AND status IN ('occupied', 'reserved') AND NOT (id = ANY($1))`,
        [ids]
      );
    });
  }
}
