import { db } from '../db.js';
import { slotSql } from '../services/predictions.js';
import { bogotaLocalSql } from '../time.js';

export async function unmetDemand() {
  const { rows } = await db().query<{ weekday: number; slot: string; zone: string; count: number }>(
    `SELECT weekday, ${slotSql(bogotaLocalSql('slot_start'))} AS slot, zone, count(*)::int AS count
       FROM unmet_demand GROUP BY 1, 2, 3 ORDER BY count DESC, weekday, slot, zone`
  );
  return { total: rows.reduce((sum, row) => sum + row.count, 0), rows };
}
