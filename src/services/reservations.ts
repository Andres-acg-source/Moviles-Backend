import type pg from 'pg';
import { holdMinutes } from '../config.js';
import { db, isUniqueViolation, withTransaction } from '../db.js';
import type { Reservation, ReservationRow } from '../types.js';
import { expireReservations } from './reservations-expiry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_RESERVATION = `
  SELECT r.id, r.spot_id, s.code AS spot_code, s.level_code, r.status, r.created_at, r.expires_at, r.checked_in_at, r.released_at
    FROM reservations r JOIN spots s ON s.id = r.spot_id`;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export const reservationVm = (row: ReservationRow): Reservation => ({
  id: row.id,
  spotId: row.spot_id,
  spotCode: row.spot_code,
  levelCode: row.level_code,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  checkedInAt: iso(row.checked_in_at),
  releasedAt: iso(row.released_at)
});

async function loadReservation(client: pg.PoolClient | pg.Pool, id: string) {
  const { rows } = await client.query<ReservationRow>(`${SELECT_RESERVATION} WHERE r.id = $1`, [id]);
  return reservationVm(rows[0]);
}

async function lockOwned(client: pg.PoolClient, userId: string, reservationId: string) {
  if (!UUID.test(reservationId)) throw new Error('RESERVATION_NOT_FOUND');
  const { rows } = await client.query<{ id: string; spot_id: string; status: string; expired: boolean; released_at: Date | null }>(
    `SELECT id, spot_id, status, expires_at <= now() AS expired, released_at
       FROM reservations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [reservationId, userId]
  );
  if (!rows[0]) throw new Error('RESERVATION_NOT_FOUND');
  return rows[0];
}

export async function createReservation(userId: string, spotId: string) {
  await expireReservations();
  try {
    return await withTransaction(async client => {
      const claimed = await client.query(
        `UPDATE spots SET status = 'reserved', held_by = $1, source = 'user', updated_at = now()
          WHERE id = $2 AND status = 'free' RETURNING id`,
        [userId, spotId]
      );
      if (!claimed.rowCount) {
        const exists = await client.query('SELECT 1 FROM spots WHERE id = $1', [spotId]);
        throw new Error(exists.rowCount ? 'SPOT_UNAVAILABLE' : 'SPOT_NOT_FOUND');
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO reservations (user_id, spot_id, source, status, expires_at)
         VALUES ($1, $2, 'user', 'active', now() + make_interval(mins => $3)) RETURNING id`,
        [userId, spotId, holdMinutes()]
      );
      return loadReservation(client, rows[0].id);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'one_active_per_user')) throw new Error('ACTIVE_RESERVATION_EXISTS');
    if (isUniqueViolation(error, 'one_open_per_spot')) throw new Error('SPOT_UNAVAILABLE');
    throw error;
  }
}

export async function checkIn(userId: string, reservationId: string) {
  await expireReservations();
  return withTransaction(async client => {
    const reservation = await lockOwned(client, userId, reservationId);
    if (reservation.status === 'expired' || (reservation.status === 'active' && reservation.expired)) throw new Error('RESERVATION_EXPIRED');
    if (reservation.status !== 'active') throw new Error('RESERVATION_NOT_ACTIVE');
    await client.query(`UPDATE reservations SET status = 'fulfilled', checked_in_at = now() WHERE id = $1`, [reservation.id]);
    await client.query(
      `UPDATE spots SET status = 'occupied', held_by = $1, source = 'user', updated_at = now() WHERE id = $2 AND held_by = $1`,
      [userId, reservation.spot_id]
    );
    return loadReservation(client, reservation.id);
  });
}

export async function release(userId: string, reservationId: string) {
  await expireReservations();
  return withTransaction(async client => {
    const reservation = await lockOwned(client, userId, reservationId);
    const next = reservation.status === 'active' ? 'cancelled' : reservation.status === 'fulfilled' && !reservation.released_at ? 'released' : undefined;
    if (!next) throw new Error('RESERVATION_NOT_OPEN');
    await client.query('UPDATE reservations SET status = $2, released_at = now() WHERE id = $1', [reservation.id, next]);
    await client.query(
      `UPDATE spots SET status = 'free', held_by = NULL, source = NULL, updated_at = now() WHERE id = $1 AND held_by = $2`,
      [reservation.spot_id, userId]
    );
    return loadReservation(client, reservation.id);
  });
}

export async function activeReservation(userId: string) {
  const { rows } = await db().query<ReservationRow>(
    `${SELECT_RESERVATION}
      WHERE r.user_id = $1
        AND ((r.status = 'active' AND r.expires_at > now()) OR (r.status = 'fulfilled' AND r.released_at IS NULL))
      ORDER BY r.created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] ? reservationVm(rows[0]) : null;
}

export async function myReservations(userId: string) {
  await expireReservations();
  const { rows } = await db().query<ReservationRow>(`${SELECT_RESERVATION} WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [userId]);
  return rows.map(reservationVm);
}

export async function vehicle(userId: string) {
  const { rows } = await db().query<{ spotId: string; spotCode: string; levelCode: string; zone: string; parkedAt: Date }>(
    `SELECT s.id AS "spotId", s.code AS "spotCode", s.level_code AS "levelCode", s.zone, r.checked_in_at AS "parkedAt"
       FROM reservations r JOIN spots s ON s.id = r.spot_id
      WHERE r.user_id = $1 AND r.status = 'fulfilled' AND r.released_at IS NULL
      ORDER BY r.checked_in_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] ? { ...rows[0], parkedAt: rows[0].parkedAt.toISOString() } : null;
}
