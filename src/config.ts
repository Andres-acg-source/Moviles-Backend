import { randomBytes } from 'node:crypto';

let generatedSecret: string | undefined;

const positiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const isProduction = () => process.env.NODE_ENV === 'production';
export const isTest = () => process.env.NODE_ENV === 'test';

export function assertConfig() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required. Set it to the PostgreSQL connection string.');
    process.exit(1);
  }
  if (isProduction() && !process.env.JWT_SECRET) {
    console.error('JWT_SECRET is required when NODE_ENV=production. Refusing to start.');
    process.exit(1);
  }
  const source = occupancySource();
  if (source !== 'simulator' && source !== 'none') {
    console.error(`OCCUPANCY_SOURCE must be "simulator" or "none", received "${source}".`);
    process.exit(1);
  }
  jwtSecret();
}

export function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (isProduction()) throw new Error('JWT_SECRET is not configured');
  if (!generatedSecret) {
    generatedSecret = randomBytes(32).toString('hex');
    if (!isTest()) console.warn('JWT_SECRET is not set: using a random secret for this run. Tokens will stop working after a restart.');
  }
  return generatedSecret;
}

export const holdMinutes = () => positiveInt(process.env.HOLD_MINUTES, 15);
export const simKey = () => process.env.SIM_KEY || undefined;
export const occupancySource = () => process.env.OCCUPANCY_SOURCE ?? 'simulator';
export const port = () => positiveInt(process.env.PORT, 3000);
