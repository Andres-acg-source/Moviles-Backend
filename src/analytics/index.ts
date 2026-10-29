import { conversionFunnel } from './conversion-funnel.js';
import { eventCounts } from './event-counts.js';
import { filterUsage } from './filter-usage.js';
import { leadTimeOverview } from './lead-time-overview.js';
import { mapLoad } from './map-load.js';
import { parking } from './parking.js';
import { predictionAccuracy } from './prediction-accuracy.js';
import { predictionUsage } from './prediction-usage.js';
import { redirectValue } from './redirect-value.js';
import { reservationPolicy } from './reservation-policy.js';
import { reservations } from './reservations.js';
import { unmetDemand } from './unmet-demand.js';
import { walkingTime } from './walking-time.js';

export async function analyticsSummary() {
  const [counts, parkingSection, reservationsSection, walking, map, filters, unmet, policy, lead, funnel, prediction, redirects, accuracy] = await Promise.all([
    eventCounts(), parking(), reservations(), walkingTime(), mapLoad(), filterUsage(), unmetDemand(), reservationPolicy(),
    leadTimeOverview(), conversionFunnel(), predictionUsage(), redirectValue(), predictionAccuracy()
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
    reservationPolicy: policy,
    leadTime: lead,
    conversionFunnel: funnel,
    predictionUsage: prediction,
    redirectValue: redirects,
    predictionAccuracy: accuracy
  };
}
