import { withTransaction } from './db.js';

const SEED_LOCK = 727_274_002;
const SPOT_SPACING_M = 2.5;
const ZONE_SPACING_M = 6;

const levels = [
  { code: 'P1', name: 'Level P1', sort: 1, underground: false, zones: ['A', 'B', 'C'], perZone: 20 },
  { code: 'P2', name: 'Level P2', sort: 2, underground: true, zones: ['A', 'B'], perZone: 24 },
  { code: 'P3', name: 'Level P3', sort: 3, underground: true, zones: ['A', 'B'], perZone: 24 }
];

const buildings = [
  { id: 'ml', name: 'Edificio Mario Laserna', x: 120, y: 40 },
  { id: 'sd', name: 'Edificio Santo Domingo', x: 200, y: -60 },
  { id: 'biblioteca', name: 'Biblioteca General', x: 300, y: 100 },
  { id: 'deportivo', name: 'Centro Deportivo', x: -350, y: 150 }
];

const nearbyLots = [
  { id: 'nearby-1', name: 'Park Central', address: 'Calle  ejercito 18', ratePerHour: 6000, currency: 'COP', walkMinutes: 6 },
  { id: 'nearby-2', name: 'City Parking', address: 'Carrera 1 19-20', ratePerHour: 7500, currency: 'COP', walkMinutes: 9 }
];

export const seedSpots = () => levels.flatMap(level => level.zones.flatMap((zone, zoneIndex) =>
  Array.from({ length: level.perZone }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return {
      id: `${level.code}-${zone}-${number}`,
      levelCode: level.code,
      zone,
      code: `${zone}-${number}`,
      isAccessible: index === 0,
      isEv: index === 1,
      isVip: index === 2,
      x: index * SPOT_SPACING_M,
      y: zoneIndex * ZONE_SPACING_M
    };
  })));

export async function seedDatabase() {
  await withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK]);
    const empty = async (table: string) => (await client.query(`SELECT NOT EXISTS (SELECT 1 FROM ${table}) AS empty`)).rows[0].empty as boolean;
    if (await empty('levels')) {
      await client.query(
        'INSERT INTO levels (code, name, sort, underground) SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::boolean[])',
        [levels.map(l => l.code), levels.map(l => l.name), levels.map(l => l.sort), levels.map(l => l.underground)]
      );
    }
    if (await empty('spots')) {
      const spots = seedSpots();
      await client.query(
        `INSERT INTO spots (id, level_code, zone, code, is_accessible, is_ev, is_vip, x_m, y_m, status)
         SELECT *, 'free' FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::boolean[], $6::boolean[], $7::boolean[], $8::real[], $9::real[])`,
        [spots.map(s => s.id), spots.map(s => s.levelCode), spots.map(s => s.zone), spots.map(s => s.code), spots.map(s => s.isAccessible), spots.map(s => s.isEv), spots.map(s => s.isVip), spots.map(s => s.x), spots.map(s => s.y)]
      );
    }
    if (await empty('buildings')) {
      await client.query(
        'INSERT INTO buildings (id, name, x_m, y_m) SELECT * FROM unnest($1::text[], $2::text[], $3::real[], $4::real[])',
        [buildings.map(b => b.id), buildings.map(b => b.name), buildings.map(b => b.x), buildings.map(b => b.y)]
      );
    }
    if (await empty('nearby_lots')) {
      await client.query(
        'INSERT INTO nearby_lots (id, name, address, rate_per_hour, currency, walk_minutes) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::int[])',
        [nearbyLots.map(n => n.id), nearbyLots.map(n => n.name), nearbyLots.map(n => n.address), nearbyLots.map(n => n.ratePerHour), nearbyLots.map(n => n.currency), nearbyLots.map(n => n.walkMinutes)]
      );
    }
  });
}
