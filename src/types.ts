export type SpotStatus = 'free' | 'reserved' | 'occupied' | 'disabled';
export type ReservationStatus = 'active' | 'fulfilled' | 'released' | 'cancelled' | 'expired';
export type Source = 'user' | 'sim';

export interface ReservationRow {
  id: string;
  spot_id: string;
  spot_code: string;
  level_code: string;
  status: ReservationStatus;
  created_at: Date;
  expires_at: Date;
  checked_in_at: Date | null;
  released_at: Date | null;
}

export interface Reservation {
  id: string;
  spotId: string;
  spotCode: string;
  levelCode: string;
  status: ReservationStatus;
  createdAt: string;
  expiresAt: string;
  checkedInAt: string | null;
  releasedAt: string | null;
}

export type TelemetryProperties = Record<string, string | number | boolean>;
