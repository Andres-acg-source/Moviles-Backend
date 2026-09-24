export type SpotState = 'free' | 'occupied' | 'reserved' | 'disabled';

export interface ParkingSpot { id: string; code: string; state: SpotState; isAccessible: boolean; isEv: boolean; isVip: boolean; walkMinutes: number }
export interface ParkingLevel { id: string; name: string; spots: ParkingSpot[] }
export interface ParkingLot { id: string; name: string; zone: string; distanceMeters: number; levels: ParkingLevel[] }
export interface ForecastPoint { hour: number; occupancy: number }
export interface Forecast { lotId: string; points: ForecastPoint[] }
export interface User { id: string; email: string; passwordHash: string }
export type ReservationStatus = 'active' | 'fulfilled' | 'cancelled' | 'expired' | 'no_show'
export interface Reservation { id: string; userId: string; lotId: string; spotId: string; spotCode: string; startsAt: string; endsAt: string; status: ReservationStatus; checkedInAt?: string }
export interface ParkedVehicle { lotId: string; lotName: string; levelName: string; spotCode: string; parkedAt: string }
export interface NearbyLot { id: string; name: string; address: string; verified: boolean; ratePerHour: number; currency: string; capacity: number; freeSpots: number; walkMinutes: number }
export interface QueueState { lotId: string; waitingVehicles: number; exitRatePerHour: number; updatedAt: string }
export interface Permit { userId: string; type: 'standard' | 'accessible' | 'ev'; expiresAt: string; verified: boolean }
export interface Payment { id: string; userId: string; reservationId?: string; amount: number; currency: string; purpose: 'reservation' | 'extension'; status: 'pending' | 'paid' | 'failed'; idempotencyKey: string; createdAt: string }
export interface TelemetryEvent { id: string; userId?: string; name: string; properties: Record<string, string | number | boolean>; createdAt: string }
export interface Database { users: User[]; lots: ParkingLot[]; forecasts: Forecast[]; reservations: Reservation[]; vehicles: Record<string, ParkedVehicle>; nearbyLots: NearbyLot[]; queues: QueueState[]; permits: Permit[]; payments: Payment[]; telemetry: TelemetryEvent[] }