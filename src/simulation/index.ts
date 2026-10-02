import type { OccupancySource } from './occupancy-source.js';
import { StaticOccupancySource } from './occupancy-source.js';
import { SimulatedOccupancySource } from './simulator.js';

export function createOccupancySource(kind: string): OccupancySource {
  return kind === 'simulator' ? new SimulatedOccupancySource() : new StaticOccupancySource();
}
