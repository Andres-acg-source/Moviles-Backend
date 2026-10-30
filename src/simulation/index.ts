import { FixedOccupancySource } from './fixed.js';
import type { OccupancySource } from './occupancy-source.js';
import { StaticOccupancySource } from './occupancy-source.js';
import { SimulatedOccupancySource } from './simulator.js';

export function createOccupancySource(kind: string): OccupancySource {
  if (kind === 'simulator') return new SimulatedOccupancySource();
  if (kind === 'fixed') return new FixedOccupancySource();
  return new StaticOccupancySource();
}
