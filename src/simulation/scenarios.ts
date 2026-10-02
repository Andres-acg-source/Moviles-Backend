const ALL_LEVELS = '*';

const overrides = new Map<string, { occupancy: number; until: Date }>();

export function setScenario(occupancyPercent: number, minutes: number, level?: string, now = new Date()) {
  const until = new Date(now.getTime() + minutes * 60_000);
  if (!level) overrides.clear();
  overrides.set(level ?? ALL_LEVELS, { occupancy: occupancyPercent / 100, until });
  return until;
}

export const clearScenarios = () => overrides.clear();

export function scenarioFor(level: string, now = new Date()) {
  for (const [key, value] of overrides) if (value.until <= now) overrides.delete(key);
  return (overrides.get(level) ?? overrides.get(ALL_LEVELS))?.occupancy;
}
