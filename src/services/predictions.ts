import { db } from '../db.js';
import { allSlotLabels, bogotaDate, bogotaLocalSql, bogotaMidnight, bogotaParts, DAY_MS, isValidIsoDate, slotLabel, weekdayOfIsoDate } from '../time.js';

export const HISTORY_DAYS = 28;
const ARRIVAL_DEFAULT_MINUTES = 20;

const local = bogotaLocalSql('taken_at');
export const slotSql = (localExpression: string) =>
  `to_char(date_trunc('hour', ${localExpression}) + floor(extract(minute FROM ${localExpression}) / 15) * interval '15 minutes', 'HH24:MI')`;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

async function levelCodes(level?: string) {
  const { rows } = await db().query<{ code: string }>('SELECT code FROM levels WHERE $1::text IS NULL OR code = $1 ORDER BY sort', [level ?? null]);
  if (level && !rows.length) throw new Error('LEVEL_NOT_FOUND');
  return rows.map(row => row.code);
}

async function averageOccupancy(weekday: number, end: Date, options: { level?: string; slot?: string } = {}) {
  const { rows } = await db().query<{ level_code: string; slot: string; occupancy: number }>(
    `SELECT level_code, ${slotSql(local)} AS slot, avg((occupied + reserved)::float8 / nullif(total, 0)) AS occupancy
       FROM occupancy_snapshots
      WHERE taken_at >= $1 AND taken_at < $2 AND extract(dow FROM ${local}) = $3
        AND ($4::text IS NULL OR level_code = $4)
      GROUP BY 1, 2`,
    [new Date(end.getTime() - HISTORY_DAYS * DAY_MS), end, weekday, options.level ?? null]
  );
  const result = new Map<string, number>();
  for (const row of rows) if (row.occupancy !== null && (!options.slot || row.slot === options.slot)) result.set(`${row.level_code}|${row.slot}`, row.occupancy);
  return result;
}

export async function predictions(date?: string, level?: string) {
  const day = date ?? bogotaDate(new Date());
  if (!isValidIsoDate(day)) throw new Error('INVALID_DATE');
  const codes = await levelCodes(level);
  const end = new Date(Math.min(bogotaMidnight(day).getTime(), Date.now()));
  const averages = await averageOccupancy(weekdayOfIsoDate(day), end, { level });
  return {
    date: day,
    intervalMinutes: 15,
    levels: codes.map(code => ({
      code,
      points: allSlotLabels().map(slot => {
        const value = averages.get(`${code}|${slot}`);
        return { slot, occupancy: value === undefined ? null : round3(value) };
      })
    }))
  };
}

export async function recommendLevel(arrivalAt?: string) {
  const arrival = arrivalAt ? new Date(arrivalAt) : new Date(Date.now() + ARRIVAL_DEFAULT_MINUTES * 60_000);
  if (Number.isNaN(arrival.getTime())) throw new Error('INVALID_ARRIVAL');
  const slot = slotLabel(arrival);
  const codes = await levelCodes();
  const averages = await averageOccupancy(bogotaParts(arrival).weekday, new Date(), { slot });
  const levels = codes.map(code => {
    const value = averages.get(`${code}|${slot}`);
    return { code, predictedOccupancy: value === undefined ? null : round3(value) };
  });
  const ranked = levels.filter(item => item.predictedOccupancy !== null).sort((a, b) => a.predictedOccupancy! - b.predictedOccupancy!);
  return { arrivalAt: arrival.toISOString(), slot, recommended: ranked[0]?.code ?? null, levels };
}
