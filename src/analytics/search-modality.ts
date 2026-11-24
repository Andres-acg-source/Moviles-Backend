import { db } from '../db.js';
import { DAY_MS } from '../time.js';

export const SEARCH_DAYS = 28;

export const SEARCH_MODES = ['voice', 'text'] as const;
type SearchMode = (typeof SEARCH_MODES)[number];

interface Row {
  platform: string;
  mode: SearchMode;
  searches: number;
  selected: number;
  no_results: number;
  fallbacks: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const share = (part: number, total: number) => (total ? round(part / total) : null);

/**
 * BQ13 (Type 3): what share of the searches in Find a spot is made by voice, and which mode ends more often in a
 * chosen spot. A search is one `searchId`; it ends in a chosen spot when a `spot_selected` carries the same id.
 */
export async function searchModality(now = new Date()) {
  const since = new Date(now.getTime() - SEARCH_DAYS * DAY_MS);
  const { rows } = await db().query<Row>(
    `WITH events AS (
       SELECT name, properties, properties->>'searchId' AS search_id,
              least(coalesce((properties->>'occurredAt')::timestamptz, created_at), created_at) AS event_at
         FROM telemetry_events
        WHERE name IN ('spot_search', 'spot_selected') AND properties->>'searchId' IS NOT NULL
     ),
     searches AS (
       SELECT DISTINCT ON (search_id)
              search_id,
              properties->>'mode' AS mode,
              coalesce(properties->>'platform', 'unknown') AS platform,
              properties->>'voiceFallback' = 'true' AS fallback,
              CASE WHEN jsonb_typeof(properties->'resultCount') = 'number'
                   THEN (properties->>'resultCount')::float8 = 0
                   ELSE false
              END AS no_results
         FROM events
        WHERE name = 'spot_search' AND properties->>'mode' IN ('voice', 'text')
          AND event_at >= $1 AND event_at < $2
        ORDER BY search_id, event_at
     ),
     selected AS (
       SELECT DISTINCT search_id FROM events WHERE name = 'spot_selected'
     )
     SELECT searches.platform, searches.mode,
            count(*)::int AS searches,
            count(selected.search_id)::int AS selected,
            count(*) FILTER (WHERE searches.no_results)::int AS no_results,
            count(*) FILTER (WHERE searches.fallback)::int AS fallbacks
       FROM searches
       LEFT JOIN selected ON selected.search_id = searches.search_id
      GROUP BY searches.platform, searches.mode
      ORDER BY searches.platform, searches.mode DESC`,
    [since, now]
  );

  const byMode = SEARCH_MODES.map(mode => {
    const matching = rows.filter(row => row.mode === mode);
    const total = (key: 'searches' | 'selected' | 'no_results') => matching.reduce((sum, row) => sum + row[key], 0);
    const searches = total('searches');
    const selected = total('selected');
    return { mode, searches, selected, selectionRate: share(selected, searches), noResults: total('no_results') };
  });
  const [voice, text] = byMode;
  const searches = voice.searches + text.searches;
  const keyboardFallbacks = rows.reduce((sum, row) => sum + (row.mode === 'text' ? row.fallbacks : 0), 0);
  const voiceAttempts = voice.searches + keyboardFallbacks;

  let higherSelectionMode: SearchMode | null = null;
  if (voice.selectionRate !== null && text.selectionRate !== null && voice.selectionRate !== text.selectionRate) {
    higherSelectionMode = voice.selectionRate > text.selectionRate ? 'voice' : 'text';
  }

  return {
    windowDays: SEARCH_DAYS,
    searches,
    voiceShare: share(voice.searches, searches),
    voiceAttempts,
    keyboardFallbacks,
    fallbackRate: share(keyboardFallbacks, voiceAttempts),
    higherSelectionMode,
    byMode,
    byPlatform: rows.map(row => ({
      platform: row.platform,
      mode: row.mode,
      searches: row.searches,
      selected: row.selected,
      selectionRate: share(row.selected, row.searches)
    }))
  };
}
