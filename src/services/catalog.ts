import { db } from '../db.js';

export const DEFAULT_DESTINATION = 'ml';
const WALK_SPEED_M_PER_S = 1.3;
const SECONDS_PER_UNDERGROUND_LEVEL = 60;

export const walkMinutes = (dx: number, dy: number, undergroundDepth: number) =>
  Math.ceil((Math.hypot(dx, dy) / WALK_SPEED_M_PER_S + SECONDS_PER_UNDERGROUND_LEVEL * undergroundDepth) / 60);

export async function buildings() {
  const { rows } = await db().query<{ id: string; name: string }>('SELECT id, name FROM buildings ORDER BY name');
  return rows;
}

export async function levelSummary() {
  const { rows } = await db().query<{ code: string; name: string; underground: boolean; total: number; free: number; reserved: number; occupied: number }>(
    `SELECT l.code, l.name, l.underground,
            count(s.id) FILTER (WHERE s.status <> 'disabled')::int AS total,
            count(s.id) FILTER (WHERE s.status = 'free')::int AS free,
            count(s.id) FILTER (WHERE s.status = 'reserved')::int AS reserved,
            count(s.id) FILTER (WHERE s.status = 'occupied')::int AS occupied
       FROM levels l LEFT JOIN spots s ON s.level_code = l.code
      GROUP BY l.code ORDER BY l.sort`
  );
  return { generatedAt: new Date().toISOString(), campusFull: rows.every(level => level.free === 0), levels: rows };
}

export interface SpotFilters { available?: boolean; accessible?: boolean; ev?: boolean; vip?: boolean }

export async function levelSpots(levelCode: string, destination: string, filters: SpotFilters, userId?: string) {
  const level = await db().query<{ depth: number }>(
    'SELECT (SELECT count(*) FROM levels u WHERE u.underground AND u.sort <= l.sort)::int AS depth FROM levels l WHERE l.code = $1',
    [levelCode]
  );
  if (!level.rows[0]) throw new Error('LEVEL_NOT_FOUND');
  const building = await db().query<{ x_m: number; y_m: number }>('SELECT x_m, y_m FROM buildings WHERE id = $1', [destination]);
  if (!building.rows[0]) throw new Error('DESTINATION_NOT_FOUND');
  const conditions = ['level_code = $1'];
  if (filters.available) conditions.push(`status = 'free'`);
  if (filters.accessible) conditions.push('is_accessible');
  if (filters.ev) conditions.push('is_ev');
  if (filters.vip) conditions.push('is_vip');
  const { rows } = await db().query(
    `SELECT id, code, zone, level_code, status, is_accessible, is_ev, is_vip, x_m, y_m, held_by
       FROM spots WHERE ${conditions.join(' AND ')} ORDER BY zone, code`,
    [levelCode]
  );
  const { depth } = level.rows[0];
  const target = building.rows[0];
  return rows.map(spot => ({
    id: spot.id,
    code: spot.code,
    zone: spot.zone,
    levelCode: spot.level_code,
    status: spot.status,
    isAccessible: spot.is_accessible,
    isEv: spot.is_ev,
    isVip: spot.is_vip,
    walkMinutes: walkMinutes(spot.x_m - target.x_m, spot.y_m - target.y_m, depth),
    mine: Boolean(userId) && spot.held_by === userId
  }));
}

export async function nearbyLots() {
  const { rows } = await db().query(
    'SELECT id, name, address, rate_per_hour AS "ratePerHour", currency, walk_minutes AS "walkMinutes" FROM nearby_lots ORDER BY walk_minutes, id'
  );
  return rows;
}
