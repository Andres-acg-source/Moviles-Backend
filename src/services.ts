import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { ParkedVehicle, Reservation } from './types.js';

const hash = (value: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
};
const matches = (value: string, stored: string) => {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest) return false;
  const actual = scryptSync(value, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export class AuthService {
  constructor(private readonly store: Store) {}
  async register(email: string, password: string, name?: string) {
    const normalized = email.toLowerCase();
    if (this.store.data.users.some(user => user.email === normalized)) throw new Error('EMAIL_EXISTS');
    const user = { id: randomUUID(), email: normalized, name, passwordHash: hash(password) };
    this.store.data.users.push(user); await this.store.save(); return user;
  }
  login(email: string, password: string) {
    const user = this.store.data.users.find(item => item.email === email.toLowerCase());
    if (!user || !matches(password, user.passwordHash)) throw new Error('INVALID_CREDENTIALS');
    return user;
  }
  profile(userId: string) {
    const user = this.store.data.users.find(item => item.id === userId);
    if (!user) throw new Error('USER_NOT_FOUND');
    return { id: user.id, email: user.email, name: user.name ?? '' };
  }
}

export class ParkingService {
  constructor(private readonly store: Store) {}
  lots() { return this.store.data.lots; }
  lot(id: string) { return this.store.data.lots.find(item => item.id === id); }
  forecast(id: string) { return this.store.data.forecasts.find(item => item.lotId === id) ?? { lotId: id, points: [] }; }
  activeReservation(userId: string) { return this.store.data.reservations.find(item => item.userId === userId && item.status === 'active' && new Date(item.endsAt) > new Date()); }
  async reserve(userId: string, lotId: string, spotId: string, durationMinutes: number) {
    if (this.activeReservation(userId)) throw new Error('ACTIVE_RESERVATION_EXISTS');
    const lot = this.lot(lotId); const spot = lot?.levels.flatMap(level => level.spots).find(item => item.id === spotId);
    if (!lot || !spot) throw new Error('SPOT_NOT_FOUND');
    if (spot.state !== 'free') throw new Error('SPOT_UNAVAILABLE');
    const startsAt = new Date(); const reservation: Reservation = { id: randomUUID(), userId, lotId, spotId, spotCode: spot.code, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + durationMinutes * 60000).toISOString(), status: 'active' };
    spot.state = 'reserved'; this.store.data.reservations.push(reservation); await this.store.save(); return reservation;
  }
  async cancel(userId: string, id: string) {
    const index = this.store.data.reservations.findIndex(item => item.id === id && item.userId === userId);
    if (index < 0) throw new Error('RESERVATION_NOT_FOUND');
    const reservation = this.store.data.reservations[index]; const spot = this.lot(reservation.lotId)?.levels.flatMap(level => level.spots).find(item => item.id === reservation.spotId);
    if (spot?.state === 'reserved') spot.state = 'free'; reservation.status = 'cancelled'; await this.store.save();
  }
  vehicle(userId: string) { return this.store.data.vehicles[userId] ?? null; }
  async saveVehicle(userId: string, vehicle: ParkedVehicle) { this.store.data.vehicles[userId] = vehicle; await this.store.save(); return vehicle; }
  async clearVehicle(userId: string) { delete this.store.data.vehicles[userId]; await this.store.save(); }
}