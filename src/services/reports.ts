import { z } from 'zod';
import { db } from '../db.js';
import { DAY_MS } from '../time.js';

export const REPORT_KINDS = ['occupied', 'blocked', 'damaged', 'other'] as const;
export const SPOT_STATUSES = ['free', 'reserved', 'occupied', 'disabled'] as const;
export const MAX_PHOTO_BYTES = 300 * 1024;
export const REPORT_BACKDATE_DAYS = 7;
export const MY_REPORTS_LIMIT = 50;

export const reportSchema = z.object({
  clientId: z.string().uuid(),
  spotId: z.string().min(1).max(40),
  kind: z.enum(REPORT_KINDS),
  shownStatus: z.enum(SPOT_STATUSES),
  note: z.string().trim().max(280).optional(),
  reportedAt: z.string().datetime({ offset: true }).optional(),
  photo: z.string().base64().optional(),
  platform: z.enum(['android', 'ios']).default('android')
});

export type ReportInput = z.infer<typeof reportSchema>;

interface ReportRow {
  id: string;
  client_id: string;
  spot_id: string;
  spot_code: string;
  level_code: string;
  kind: string;
  note: string | null;
  shown_status: string;
  has_photo: boolean;
  reported_at: Date;
}

const columns = `r.id, r.client_id, r.spot_id, s.code AS spot_code, r.level_code, r.kind, r.note, r.shown_status,
                 r.photo IS NOT NULL AS has_photo, r.reported_at`;

const toReport = (row: ReportRow) => ({
  id: row.id,
  clientId: row.client_id,
  spotId: row.spot_id,
  spotCode: row.spot_code,
  levelCode: row.level_code,
  kind: row.kind,
  note: row.note,
  shownStatus: row.shown_status,
  reportedAt: row.reported_at.toISOString(),
  photoUrl: row.has_photo ? `/api/v1/reports/${row.id}/photo` : null
});

function decodePhoto(photo: string | undefined) {
  if (photo === undefined) return null;
  const bytes = Buffer.from(photo, 'base64');
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error('PHOTO_TOO_LARGE');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error('PHOTO_NOT_JPEG');
  return bytes;
}

function reportTime(reportedAt: string | undefined, now: Date) {
  if (reportedAt === undefined) return now;
  const time = new Date(reportedAt);
  const oldest = new Date(now.getTime() - REPORT_BACKDATE_DAYS * DAY_MS);
  if (time > now) return now;
  return time < oldest ? oldest : time;
}

/**
 * Saves a report about a spot. The level comes from the spot, and the same clientId sent again by the same user returns
 * the report saved the first time, so a phone that retries after losing the signal never creates it twice.
 */
export async function createReport(userId: string, input: ReportInput, now = new Date()) {
  const photo = decodePhoto(input.photo);
  const { rows } = await db().query<ReportRow & { created: boolean }>(
    `WITH spot AS (SELECT id, level_code FROM spots WHERE id = $3::text),
     inserted AS (
       INSERT INTO spot_reports (user_id, client_id, spot_id, level_code, kind, note, shown_status, photo, reported_at, platform)
       SELECT $1::uuid, $2::uuid, spot.id, spot.level_code, $4::text, $5::text, $6::text, $7::bytea, $8::timestamptz, $9::text
         FROM spot
       ON CONFLICT (user_id, client_id) DO NOTHING
       RETURNING *
     )
     SELECT ${columns}, true AS created FROM inserted r JOIN spots s ON s.id = r.spot_id
     UNION ALL
     SELECT ${columns}, false AS created FROM spot_reports r JOIN spots s ON s.id = r.spot_id
      WHERE r.user_id = $1::uuid AND r.client_id = $2::uuid`,
    [userId, input.clientId, input.spotId, input.kind, input.note || null, input.shownStatus, photo, reportTime(input.reportedAt, now), input.platform]
  );
  if (!rows.length) throw new Error('SPOT_NOT_FOUND');
  const [row] = rows;
  return { created: row.created, report: toReport(row) };
}

export async function myReports(userId: string) {
  const { rows } = await db().query<ReportRow>(
    `SELECT ${columns} FROM spot_reports r JOIN spots s ON s.id = r.spot_id
      WHERE r.user_id = $1 ORDER BY r.reported_at DESC LIMIT $2`,
    [userId, MY_REPORTS_LIMIT]
  );
  return { reports: rows.map(toReport) };
}

export async function reportPhoto(userId: string, reportId: string) {
  if (!z.string().uuid().safeParse(reportId).success) throw new Error('REPORT_NOT_FOUND');
  const { rows } = await db().query<{ photo: Buffer | null }>(
    'SELECT photo FROM spot_reports WHERE id = $1 AND user_id = $2',
    [reportId, userId]
  );
  const photo = rows[0]?.photo;
  if (!photo) throw new Error('REPORT_NOT_FOUND');
  return photo;
}