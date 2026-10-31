import { db } from '../db.js';
import { HISTORY_DAYS, slotSql } from '../services/predictions.js';
import { allSlotLabels, bogotaLocalSql, DAY_MS } from '../time.js';

interface AvailabilityRow {
  level_code: string;
  slot: string;
  accessible_samples: number;
  accessible_available: number;
  ev_samples: number;
  ev_available: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

const percentage = (available: number, samples: number) =>
  samples === 0 ? null : round((available / samples) * 100);

export async function specialAvailability() {
  const until = new Date();
  const since = new Date(until.getTime() - HISTORY_DAYS * DAY_MS);
  const local = bogotaLocalSql('taken_at');

  const [levels, availability] = await Promise.all([
    db().query<{ code: string }>(
      'SELECT code FROM levels ORDER BY sort'
    ),
    db().query<AvailabilityRow>(
      `SELECT level_code,
              ${slotSql(local)} AS slot,
              count(free_accessible)::int AS accessible_samples,
              count(*) FILTER (WHERE free_accessible > 0)::int AS accessible_available,
              count(free_ev)::int AS ev_samples,
              count(*) FILTER (WHERE free_ev > 0)::int AS ev_available
         FROM occupancy_snapshots
        WHERE taken_at >= $1 AND taken_at <= $2
        GROUP BY level_code, 2
        ORDER BY level_code, 2`,
      [since, until]
    )
  ]);

  const grouped = new Map(
    availability.rows.map(row => [`${row.level_code}|${row.slot}`, row])
  );

  return {
    period: {
      days: HISTORY_DAYS,
      since: since.toISOString(),
      until: until.toISOString()
    },
    intervalMinutes: 15,
    levels: levels.rows.map(({ code }) => ({
      code,
      slots: allSlotLabels().map(slot => {
        const row = grouped.get(`${code}|${slot}`);
        const accessibleSamples = row?.accessible_samples ?? 0;
        const evSamples = row?.ev_samples ?? 0;

        return {
          slot,
          accessibleAvailability: percentage(
            row?.accessible_available ?? 0,
            accessibleSamples
          ),
          evAvailability: percentage(
            row?.ev_available ?? 0,
            evSamples
          ),
          accessibleSamples,
          evSamples
        };
      })
    }))
  };
}
