import { z } from 'zod';
import { db } from '../db.js';
import type { TelemetryProperties } from '../types.js';

export const telemetrySchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, 'name must be snake_case'),
  properties: z.record(z.string().min(1).max(40), z.union([z.string().max(200), z.number().finite(), z.boolean()]))
    .refine(value => Object.keys(value).length <= 20, 'properties can have at most 20 keys')
    .default({})
});

export async function recordEvent(userId: string | undefined, name: string, properties: TelemetryProperties) {
  await db().query('INSERT INTO telemetry_events (user_id, name, properties) VALUES ($1, $2, $3)', [userId ?? null, name, properties]);
}
