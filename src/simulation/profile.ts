import { bogotaParts } from '../time.js';

const NOISE = 0.05;

const WEEKDAY_BY_HOUR = Array.from({ length: 24 }, (_, hour) => {
  if (hour === 7) return 0.45;
  if (hour >= 8 && hour <= 11) return 0.95;
  if (hour === 12) return 0.7;
  if (hour >= 13 && hour <= 16) return 0.85;
  if (hour === 17) return 0.55;
  if (hour >= 18 && hour <= 20) return 0.3;
  return 0.1;
});

const LEVEL_FACTOR: Record<string, number> = { P1: 1, P2: 0.9, P3: 0.8 };

const dayFactor = (weekday: number) => (weekday === 0 ? 0.15 : weekday === 6 ? 0.5 : 1);

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function baseOccupancy(levelCode: string, date: Date) {
  const { hour, weekday } = bogotaParts(date);
  return WEEKDAY_BY_HOUR[hour] * dayFactor(weekday) * (LEVEL_FACTOR[levelCode] ?? 1);
}

export const targetOccupancy = (levelCode: string, date: Date, random: () => number = Math.random) =>
  clamp01(baseOccupancy(levelCode, date) + (random() * 2 - 1) * NOISE);
