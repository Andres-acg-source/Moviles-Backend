import { createHash } from 'node:crypto';

export const CHECK_IN_PROBABILITY = 0.8;
const MIN_CHECK_IN_MINUTES = 3;
const MAX_CHECK_IN_MINUTES = 20;
const MIN_STAY_MINUTES = 60;
const MAX_STAY_MINUTES = 240;

const uniforms = (seed: string) => {
  const digest = createHash('sha256').update(seed).digest();
  return [0, 4, 8].map(offset => digest.readUInt32BE(offset) / 0x1_0000_0000);
};

export function checkInDelayMinutes(u: number, hold: number) {
  const latest = Math.max(MIN_CHECK_IN_MINUTES, Math.min(MAX_CHECK_IN_MINUTES, hold - 1));
  return MIN_CHECK_IN_MINUTES + u * (latest - MIN_CHECK_IN_MINUTES);
}

export const stayMinutes = (u: number) => MIN_STAY_MINUTES + u * (MAX_STAY_MINUTES - MIN_STAY_MINUTES);

export function driverPlan(reservationId: string, hold: number) {
  const [show, delay, stay] = uniforms(reservationId);
  return {
    checkInAfterMinutes: show < CHECK_IN_PROBABILITY ? checkInDelayMinutes(delay, hold) : null,
    stayMinutes: stayMinutes(stay)
  };
}
