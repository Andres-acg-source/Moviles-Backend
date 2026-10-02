import { eventCounts } from './event-counts.js';
import { filterUsage } from './filter-usage.js';
import { mapLoad } from './map-load.js';
import { parking } from './parking.js';
import { reservationPolicy } from './reservation-policy.js';
import { reservations } from './reservations.js';
import { unmetDemand } from './unmet-demand.js';
import { walkingTime } from './walking-time.js';

export async function analyticsSummary() {
  const [counts, parkingSection, reservationsSection, walking, map, filters, unmet, policy] = await Promise.all([
    eventCounts(), parking(), reservations(), walkingTime(), mapLoad(), filterUsage(), unmetDemand(), reservationPolicy()
  ]);
  return {
    generatedAt: new Date().toISOString(),
    eventCounts: counts,
    parking: parkingSection,
    reservations: reservationsSection,
    walkingTime: walking,
    mapLoad: map,
    filterUsage: filters,
    unmetDemand: unmet,
    reservationPolicy: policy
  };
}
