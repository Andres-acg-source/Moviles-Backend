import { db } from '../db.js';
import { bogotaLocalSql, DAY_MS } from '../time.js';

export const REPORT_DAYS = 28;

interface Row {
  level: string;
  hour: number;
  reports: number;
  contradicting: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const share = (part: number, total: number) => (total ? round(part / total) : null);
const withRate = <T extends { reports: number; contradicting: number }>(row: T) => ({
  ...row,
  mismatchRate: share(row.contradicting, row.reports)
});

/**
 * BQ15 (Type *): how far the state ParkWise shows is from what drivers find on site, by level and hour (Bogotá time).
 * Every report saves the state the app showed for the spot. A report contradicts the app when the spot was shown as
 * free and the driver found it occupied without a reservation or blocked.
 */
export async function reportMismatch(now = new Date()) {
  const since = new Date(now.getTime() - REPORT_DAYS * DAY_MS);
  const [{ rows }, levels] = await Promise.all([
    db().query<Row>(
      `SELECT level_code AS level, extract(hour FROM ${bogotaLocalSql('reported_at')})::int AS hour,
              count(*)::int AS reports,
              count(*) FILTER (WHERE kind IN ('occupied', 'blocked') AND shown_status = 'free')::int AS contradicting
         FROM spot_reports
        WHERE reported_at >= $1 AND reported_at <= $2
        GROUP BY 1, 2
        ORDER BY 1, 2`,
      [since, now]
    ),
    db().query<{ code: string }>('SELECT code FROM levels ORDER BY sort')
  ]);

  const total = (key: 'reports' | 'contradicting', match: (row: Row) => boolean = () => true) =>
    rows.reduce((sum, row) => sum + (match(row) ? row[key] : 0), 0);
  let worstSlot: Row | null = null;
  for (const row of rows) {
    if (!row.contradicting) continue;
    const better = !worstSlot || row.contradicting > worstSlot.contradicting
      || (row.contradicting === worstSlot.contradicting && row.contradicting / row.reports > worstSlot.contradicting / worstSlot.reports);
    if (better) worstSlot = row;
  }

  return {
    windowDays: REPORT_DAYS,
    ...withRate({ reports: total('reports'), contradicting: total('contradicting') }),
    worstSlot: worstSlot && withRate(worstSlot),
    byLevel: levels.rows.map(({ code }) => withRate({
      level: code,
      reports: total('reports', row => row.level === code),
      contradicting: total('contradicting', row => row.level === code)
    })),
    bySlot: rows.map(withRate)
  };
}
