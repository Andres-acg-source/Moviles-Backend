import type { Request } from 'express';
import { db } from '../db.js';
import { bogotaParts, slotStart } from '../time.js';

const ZONE_FORMAT = /^-?\d{1,2}\.\d{2},-?\d{1,3}\.\d{2}$/;

export async function recordAvailabilityQuery(req: Request, campusFull: boolean) {
  const zone = typeof req.query.zone === 'string' ? req.query.zone : undefined;
  if (!campusFull || !req.userId || !zone || !ZONE_FORMAT.test(zone)) return;
  const now = new Date();
  try {
    await db().query(
      `INSERT INTO unmet_demand (user_id, slot_start, weekday, zone) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, slot_start) DO NOTHING`,
      [req.userId, slotStart(now), bogotaParts(now).weekday, zone]
    );
  } catch (error) {
    console.error('[unmet-demand] insert failed:', error instanceof Error ? error.message : error);
  }
}
