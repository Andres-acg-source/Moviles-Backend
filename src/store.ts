import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Database, ParkingLot } from './types.js';

const spots = (row: string, count: number, free: number) => Array.from({ length: count }, (_, i) => ({
  id: `${row}-${String(i + 1).padStart(2, '0')}`,
  code: `${row}-${String(i + 1).padStart(2, '0')}`,
  state: i < free ? 'free' as const : 'occupied' as const,
  isAccessible: i === 0,
  isEv: i === 1,
  isVip: i === 2,
  walkMinutes: 2 + (i % 6)
}));

const seedLots: ParkingLot[] = [
  { id: 'p1', name: 'P1 · North', zone: 'North campus', distanceMeters: 120, levels: [
    { id: 'p1-l1', name: 'Level 1', spots: spots('A', 20, 4) },
    { id: 'p1-l2', name: 'Level 2', spots: spots('B', 20, 11) },
    { id: 'p1-l3', name: 'Level 3', spots: spots('C', 20, 17) }
  ] },
  { id: 'p2', name: 'P2 · Library', zone: 'Central campus', distanceMeters: 340, levels: [
    { id: 'p2-l1', name: 'Level 1', spots: spots('A', 16, 1) },
    { id: 'p2-l2', name: 'Level 2', spots: spots('B', 16, 0) }
  ] },
  { id: 'p3', name: 'P3 · South', zone: 'South campus', distanceMeters: 610, levels: [{ id: 'p3-l1', name: 'Level 1', spots: spots('A', 24, 0) }] }
];

const seed: Database = {
  users: [], lots: seedLots,
  forecasts: [{ lotId: 'p1', points: [0.3, 0.65, 0.9, 0.95, 0.92, 0.8, 0.75, 0.85, 0.7, 0.5, 0.35, 0.2].map((occupancy, i) => ({ hour: i + 7, occupancy })) }],
  reservations: [], vehicles: {},
  nearbyLots: [
    { id: 'nearby-1', name: 'Park Central', address: 'Calle  ejercito 18', verified: true, ratePerHour: 6000, currency: 'COP', capacity: 120, freeSpots: 38, walkMinutes: 6 },
    { id: 'nearby-2', name: 'City Parking', address: 'Carrera 1 19-20', verified: true, ratePerHour: 7500, currency: 'COP', capacity: 80, freeSpots: 12, walkMinutes: 9 }
  ],
  queues: seedLots.map(lot => ({ lotId: lot.id, waitingVehicles: lot.id === 'p1' ? 4 : 0, exitRatePerHour: 18, updatedAt: new Date().toISOString() })),
  permits: [], payments: [], telemetry: []
};

export class Store {
  private constructor(private readonly file: string, private db: Database) {}

  static async open(file: string): Promise<Store> {
    try {
      const data = JSON.parse(await readFile(file, 'utf8')) as Partial<Database>;
      const normalized: Database = { ...structuredClone(seed), ...data, nearbyLots: data.nearbyLots ?? structuredClone(seed.nearbyLots), queues: data.queues ?? [], permits: data.permits ?? [], payments: data.payments ?? [], telemetry: data.telemetry ?? [], lots: data.lots ?? structuredClone(seed.lots), reservations: data.reservations ?? [] };
      normalized.lots = normalized.lots.map(lot => ({ ...lot, levels: lot.levels.map(level => ({ ...level, spots: level.spots.map((spot, index) => ({ ...spot, isVip: spot.isVip ?? index === 2, walkMinutes: spot.walkMinutes ?? 2 + (index % 6) })) })) }));
      normalized.reservations = normalized.reservations.map(reservation => ({ ...reservation, status: reservation.status ?? 'active' }));
      return new Store(file, normalized);
    }
    catch { const store = new Store(file, structuredClone(seed)); await store.save(); return store; }
  }

  get data() { return this.db; }
  async save() { await mkdir(dirname(this.file), { recursive: true }); await writeFile(this.file, JSON.stringify(this.db, null, 2)); }
}