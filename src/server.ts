import 'dotenv/config';
import { createApp } from './app.js';
import { assertConfig, occupancySource, port } from './config.js';
import { closeDb, initDb, migrate } from './db.js';
import { seedDatabase } from './seed.js';
import { ensureHistory } from './simulation/history.js';
import { createOccupancySource } from './simulation/index.js';

assertConfig();
initDb(process.env.DATABASE_URL!);

const applied = await migrate();
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
await seedDatabase();

const occupancy = createOccupancySource(occupancySource());
if (occupancySource() === 'simulator' && (await ensureHistory())) console.log('Generated 4 weeks of simulated occupancy history');
occupancy.start();

const server = createApp({ occupancy }).listen(port(), () => {
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port();
  console.log(`ParkWise API listening on port ${actualPort} (occupancy source: ${occupancySource()})`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();
  server.close();
  server.closeIdleConnections();
  await occupancy.stop();
  await closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
