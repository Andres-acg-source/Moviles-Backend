import { holdMinutes, isTest } from '../config.js';
import { db, withTransaction } from '../db.js';
import { expireReservations } from '../services/reservations-expiry.js';
import { slotStart } from '../time.js';
import { driverPlan } from './driver-plan.js';
import type { OccupancySource, TickOptions } from './occupancy-source.js';
import { baseOccupancy, targetOccupancy } from './profile.js';
import { scenarioFor } from './scenarios.js';

const TICK_MS = 60_000;
const PROFILE_STEP = 0.5;
const SIM_RESERVATIONS_PER_TICK = 0.15;

const NO_OPEN_RESERVATION = `NOT EXISTS (
  SELECT 1 FROM reservations r
   WHERE r.spot_id = s.id AND (r.status = 'active' OR (r.status = 'fulfilled' AND r.released_at IS NULL)))`;

interface LevelState { code: string; total: number; busy: number }

export interface SimulatorOptions { now?: () => Date; random?: () => number }

export class SimulatedOccupancySource implements OccupancySource {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private lastSnapshotSlot?: number;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(options: SimulatorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  start() {
    if (isTest() || this.timer) return;
    const run = () => this.tick().catch(error => console.error('[simulator] tick failed:', error instanceof Error ? error.message : error));
    void run();
    this.timer = setInterval(run, TICK_MS);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  tick(options: TickOptions = {}) {
    const previous = this.running ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.runTick(options));
    this.running = current;
    return current;
  }

  private async runTick({ force = false }: TickOptions) {
    const now = this.now();
    await expireReservations();
    const levels = await this.levelStates();
    const scenarioLevels = new Set<string>();
    for (const level of levels) {
      const scenario = scenarioFor(level.code, now);
      if (scenario !== undefined) scenarioLevels.add(level.code);
      const target = scenario ?? targetOccupancy(level.code, now, this.random);
      const gap = Math.round(target * level.total) - level.busy;
      const step = scenario !== undefined || force ? gap : Math.sign(gap) * Math.ceil(Math.abs(gap) * PROFILE_STEP);
      if (step > 0) await this.fill(level.code, step);
      if (step < 0) await this.vacate(level.code, -step);
    }
    await this.simulateDrivers(levels.map(level => level.code).filter(code => !scenarioLevels.has(code)), now);
    await this.snapshot(now);
  }

  private async levelStates() {
    const { rows } = await db().query<LevelState>(
      `SELECT l.code,
              count(s.id) FILTER (WHERE s.status <> 'disabled')::int AS total,
              count(s.id) FILTER (WHERE s.status IN ('occupied', 'reserved'))::int AS busy
         FROM levels l LEFT JOIN spots s ON s.level_code = l.code
        GROUP BY l.code, l.sort ORDER BY l.sort`
    );
    return rows;
  }

  private async fill(levelCode: string, count: number) {
    await db().query(
      `UPDATE spots SET status = 'occupied', source = 'sim', updated_at = now()
        WHERE id IN (
          SELECT s.id FROM spots s
           WHERE s.level_code = $1 AND s.status = 'free' AND s.held_by IS NULL AND ${NO_OPEN_RESERVATION}
           ORDER BY random() LIMIT $2 FOR UPDATE SKIP LOCKED)
          AND status = 'free' AND held_by IS NULL`,
      [levelCode, count]
    );
  }

  private async vacate(levelCode: string, count: number) {
    await db().query(
      `UPDATE spots SET status = 'free', source = NULL, updated_at = now()
        WHERE id IN (
          SELECT s.id FROM spots s
           WHERE s.level_code = $1 AND s.status = 'occupied' AND s.source = 'sim' AND s.held_by IS NULL AND ${NO_OPEN_RESERVATION}
           ORDER BY random() LIMIT $2 FOR UPDATE SKIP LOCKED)
          AND status = 'occupied' AND source = 'sim' AND held_by IS NULL`,
      [levelCode, count]
    );
  }

  private async simulateDrivers(levelCodes: string[], now: Date) {
    if (!levelCodes.length) return;
    for (const code of levelCodes) {
      if (this.random() < baseOccupancy(code, now) * SIM_RESERVATIONS_PER_TICK) await this.createSimReservation(code);
    }
    const hold = holdMinutes();
    const { rows } = await db().query<{ id: string; spot_id: string; status: string; created_at: Date; checked_in_at: Date | null }>(
      `SELECT r.id, r.spot_id, r.status, r.created_at, r.checked_in_at
         FROM reservations r JOIN spots s ON s.id = r.spot_id
        WHERE r.source = 'sim' AND s.level_code = ANY($1)
          AND ((r.status = 'active' AND r.expires_at > now()) OR (r.status = 'fulfilled' AND r.released_at IS NULL))`,
      [levelCodes]
    );
    const elapsedMinutes = (since: Date) => (Date.now() - since.getTime()) / 60_000;
    const arrivals: string[] = [];
    const departures: string[] = [];
    for (const row of rows) {
      const plan = driverPlan(row.id, hold);
      if (row.status === 'active' && plan.checkInAfterMinutes !== null && elapsedMinutes(row.created_at) >= plan.checkInAfterMinutes) arrivals.push(row.id);
      if (row.status === 'fulfilled' && row.checked_in_at && elapsedMinutes(row.checked_in_at) >= plan.stayMinutes) departures.push(row.id);
    }
    if (arrivals.length) {
      await withTransaction(async client => {
        const { rows: spots } = await client.query<{ spot_id: string }>(
          `UPDATE reservations SET status = 'fulfilled', checked_in_at = now()
            WHERE id = ANY($1) AND status = 'active' AND expires_at > now() RETURNING spot_id`,
          [arrivals]
        );
        await client.query(
          `UPDATE spots SET status = 'occupied', updated_at = now() WHERE id = ANY($1) AND source = 'sim' AND held_by IS NULL`,
          [spots.map(spot => spot.spot_id)]
        );
      });
    }
    if (departures.length) {
      await withTransaction(async client => {
        const { rows: spots } = await client.query<{ spot_id: string }>(
          `UPDATE reservations SET status = 'released', released_at = now()
            WHERE id = ANY($1) AND status = 'fulfilled' AND released_at IS NULL RETURNING spot_id`,
          [departures]
        );
        await client.query(
          `UPDATE spots SET status = 'free', source = NULL, updated_at = now() WHERE id = ANY($1) AND source = 'sim' AND held_by IS NULL`,
          [spots.map(spot => spot.spot_id)]
        );
      });
    }
  }

  private async createSimReservation(levelCode: string) {
    await withTransaction(async client => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE spots SET status = 'reserved', source = 'sim', updated_at = now()
          WHERE id = (
            SELECT s.id FROM spots s
             WHERE s.level_code = $1 AND s.status = 'free' AND s.held_by IS NULL AND ${NO_OPEN_RESERVATION}
             ORDER BY random() LIMIT 1 FOR UPDATE SKIP LOCKED)
            AND status = 'free' AND held_by IS NULL
          RETURNING id`,
        [levelCode]
      );
      if (!rows[0]) return;
      await client.query(
        `INSERT INTO reservations (user_id, spot_id, source, status, expires_at)
         VALUES (NULL, $1, 'sim', 'active', now() + make_interval(mins => $2))`,
        [rows[0].id, holdMinutes()]
      );
    });
  }

  private async snapshot(now: Date) {
    const slot = slotStart(now);
    if (this.lastSnapshotSlot === slot.getTime()) return;
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
    this.lastSnapshotSlot = slot.getTime();
  }
}
