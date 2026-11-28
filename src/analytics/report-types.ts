import { db } from '../db.js';
import { DAY_MS } from '../time.js';
import { REPORT_KINDS } from '../services/reports.js';

export const REPORT_TYPES_DAYS = 28;

type ReportKind = (typeof REPORT_KINDS)[number];
type Platform = 'android' | 'ios';

interface Row {
  kind: ReportKind;
  platform: Platform;
  reports: number;
  withPhoto: number;
  withNote: number;
}

const round = (value: number) =>
  Math.round(value * 1000) / 1000;

const share = (part: number, total: number) =>
  total ? round(part / total) : null;

function totals(rows: Row[]) {
  const reports = rows.reduce(
    (sum, row) => sum + row.reports, 0
  );

  const withPhoto = rows.reduce(
    (sum, row) => sum + row.withPhoto, 0
  );

  const withNote = rows.reduce(
    (sum, row) => sum + row.withNote, 0
  );

  return {
    reports,
    withPhoto,
    photoShare: share(withPhoto, reports),
    withNote,
    noteShare: share(withNote, reports)
  };
}

/**
 * BQ18 (Type 3): which parking spot problems are reported
 * most often, and how many reports include a photo or note,
 * by problem type and platform during the last 28 days.
 */
export async function reportTypes(now = new Date()) {
  const since = new Date(
    now.getTime() - REPORT_TYPES_DAYS * DAY_MS
  );

  const { rows } = await db().query<Row>(
    `SELECT kind, platform,
            count(*)::int AS reports,
            count(*) FILTER (
              WHERE photo IS NOT NULL
            )::int AS "withPhoto",
            count(*) FILTER (
              WHERE note IS NOT NULL
            )::int AS "withNote"
       FROM spot_reports
      WHERE reported_at >= $1
        AND reported_at <= $2
      GROUP BY kind, platform
      ORDER BY kind, platform`,
    [since, now]
  );

  const overall = totals(rows);

  const byKind = REPORT_KINDS.map(kind => {
    const counts = totals(
      rows.filter(row => row.kind === kind)
    );

    return {
      kind,
      reports: counts.reports,
      share: share(counts.reports, overall.reports),
      withPhoto: counts.withPhoto,
      photoShare: counts.photoShare,
      withNote: counts.withNote,
      noteShare: counts.noteShare
    };
  });

  const platforms: Platform[] = ['android', 'ios'];

  const byPlatform = platforms
    .map(platform => {
      const counts = totals(
        rows.filter(row => row.platform === platform)
      );

      return {
        platform,
        reports: counts.reports,
        photoShare: counts.photoShare,
        noteShare: counts.noteShare
      };
    })
    .filter(row => row.reports > 0);

  let mostReported: ReportKind | null = null;
  let maxReports = 0;

  for (const row of byKind) {
    if (row.reports > maxReports) {
      maxReports = row.reports;
      mostReported = row.kind;
    }
  }

  return {
    windowDays: REPORT_TYPES_DAYS,
    ...overall,
    byKind,
    byPlatform,
    mostReported
  };
}