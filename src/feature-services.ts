import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { ParkedVehicle, Payment, Permit, Reservation, TelemetryEvent } from './types.js';

export class IntelligenceService {
  constructor(private readonly store: Store) {}

  search(query: string | undefined, filters: { available?: boolean; accessible?: boolean; ev?: boolean; vip?: boolean; lotId?: string }) {
    const normalized = query?.toLowerCase().trim();
    return this.store.data.lots.flatMap(lot => lot.levels.flatMap(level => level.spots.map(spot => ({ lot, level, spot }))))
      .filter(({ lot, level, spot }) => !filters.lotId || lot.id === filters.lotId)
      .filter(({ lot, level, spot }) => !normalized || [lot.name, lot.zone, level.name, spot.code].some(value => value.toLowerCase().includes(normalized)))
      .filter(({ spot }) => filters.available !== true || spot.state === 'free')
      .filter(({ spot }) => filters.accessible !== true || spot.isAccessible)
      .filter(({ spot }) => filters.ev !== true || spot.isEv)
      .filter(({ spot }) => filters.vip !== true || spot.isVip)
      .map(({ lot, level, spot }) => ({ lotId: lot.id, lotName: lot.name, levelId: level.id, levelName: level.name, ...spot }));
  }

  forecast(lotId: string, arrivalAt?: string) {
    const base = this.store.data.forecasts.find(item => item.lotId === lotId) ?? { lotId, points: [] };
    const lots = this.store.data.lots.find(item => item.id === lotId);
    const levels = lots?.levels.map(level => ({ levelId: level.id, levelName: level.name, totalSpots: level.spots.length, freeSpots: level.spots.filter(spot => spot.state === 'free').length, points: base.points.map(point => ({ ...point, occupancy: Math.min(1, Math.max(0, point.occupancy + (level.id.charCodeAt(level.id.length - 1) % 3 - 1) * 0.04)) })) })) ?? [];
    return { ...base, intervalMinutes: 15, arrivalAt: arrivalAt ?? null, levels };
  }

  nearbyLots() { return this.store.data.nearbyLots.filter(lot => lot.verified && lot.freeSpots > 0).sort((a, b) => a.walkMinutes - b.walkMinutes); }
  queue(lotId: string) { return this.store.data.queues.find(queue => queue.lotId === lotId) ?? { lotId, waitingVehicles: 0, exitRatePerHour: 0, updatedAt: new Date().toISOString() }; }

  async reportStale(lotId: string, spotId: string) {
    const spot = this.store.data.lots.find(lot => lot.id === lotId)?.levels.flatMap(level => level.spots).find(item => item.id === spotId);
    if (!spot) throw new Error('SPOT_NOT_FOUND');
    if (spot.state === 'occupied') spot.state = 'free';
    await this.store.save(); return { ...spot, verifiedAt: new Date().toISOString() };
  }
}

export class LifecycleService {
  constructor(private readonly store: Store) {}

  async checkIn(userId: string, reservationId: string) {
    const reservation = this.store.data.reservations.find(item => item.id === reservationId && item.userId === userId && item.status === 'active');
    if (!reservation) throw new Error('RESERVATION_NOT_FOUND');
    const lot = this.store.data.lots.find(item => item.id === reservation.lotId); const level = lot?.levels.find(item => item.spots.some(spot => spot.id === reservation.spotId)); const spot = level?.spots.find(item => item.id === reservation.spotId);
    if (!lot || !level || !spot) throw new Error('SPOT_NOT_FOUND');
    spot.state = 'occupied'; reservation.status = 'fulfilled'; reservation.checkedInAt = new Date().toISOString();
    const vehicle: ParkedVehicle = { lotId: lot.id, lotName: lot.name, levelName: level.name, spotCode: spot.code, parkedAt: reservation.checkedInAt };
    this.store.data.vehicles[userId] = vehicle; await this.store.save(); return { reservation, vehicle };
  }

  async checkOut(userId: string) {
    const vehicle = this.store.data.vehicles[userId]; if (!vehicle) throw new Error('VEHICLE_NOT_FOUND');
    const lot = this.store.data.lots.find(item => item.id === vehicle.lotId); const spot = lot?.levels.flatMap(level => level.spots).find(item => item.code === vehicle.spotCode); if (spot) spot.state = 'free';
    delete this.store.data.vehicles[userId]; await this.store.save(); return { releasedSpot: vehicle.spotCode, checkedOutAt: new Date().toISOString() };
  }

  permit(userId: string) { return this.store.data.permits.find(item => item.userId === userId) ?? null; }
  async savePermit(permit: Permit) { const index = this.store.data.permits.findIndex(item => item.userId === permit.userId); if (index >= 0) this.store.data.permits[index] = permit; else this.store.data.permits.push(permit); await this.store.save(); return permit; }

  async payment(userId: string, amount: number, purpose: Payment['purpose'], idempotencyKey: string, reservationId?: string) {
    const existing = this.store.data.payments.find(item => item.userId === userId && item.idempotencyKey === idempotencyKey); if (existing) return existing;
    const payment: Payment = { id: randomUUID(), userId, reservationId, amount, currency: 'COP', purpose, status: 'paid', idempotencyKey, createdAt: new Date().toISOString() };
    this.store.data.payments.push(payment); await this.store.save(); return payment;
  }

  async event(userId: string | undefined, name: string, properties: TelemetryEvent['properties']) {
    this.store.data.telemetry.push({ id: randomUUID(), userId, name, properties, createdAt: new Date().toISOString() }); await this.store.save();
  }

  analytics() {
    const events = this.store.data.telemetry; const byName = events.reduce<Record<string, number>>((result, event) => { result[event.name] = (result[event.name] ?? 0) + 1; return result; }, {});
    const free = this.store.data.lots.flatMap(lot => lot.levels.flatMap(level => level.spots));
    return { generatedAt: new Date().toISOString(), eventCounts: byName, parking: { totalSpots: free.length, freeSpots: free.filter(spot => spot.state === 'free').length, accessibleFree: free.filter(spot => spot.isAccessible && spot.state === 'free').length, evFree: free.filter(spot => spot.isEv && spot.state === 'free').length }, reservations: { active: this.store.data.reservations.filter(item => item.status === 'active').length, fulfilled: this.store.data.reservations.filter(item => item.status === 'fulfilled').length, noShow: this.store.data.reservations.filter(item => item.status === 'no_show').length } };
  }
}