export const errorTable: Record<string, [number, string]> = {
  EMAIL_EXISTS: [409, 'Email already registered'],
  INVALID_CREDENTIALS: [401, 'Invalid credentials'],
  AUTH_REQUIRED: [401, 'Authentication required'],
  INVALID_TOKEN: [401, 'Invalid token'],
  USER_NOT_FOUND: [401, 'User no longer exists'],
  LEVEL_NOT_FOUND: [404, 'Level not found'],
  DESTINATION_NOT_FOUND: [400, 'Destination building not found'],
  SPOT_NOT_FOUND: [404, 'Parking spot not found'],
  SPOT_UNAVAILABLE: [409, 'Parking spot is not available'],
  ACTIVE_RESERVATION_EXISTS: [409, 'An active reservation already exists'],
  RESERVATION_NOT_FOUND: [404, 'Reservation not found'],
  RESERVATION_EXPIRED: [409, 'Reservation has expired'],
  RESERVATION_NOT_ACTIVE: [409, 'Reservation is not active'],
  RESERVATION_NOT_OPEN: [409, 'Reservation is already closed'],
  INVALID_DATE: [400, 'Invalid date, expected YYYY-MM-DD'],
  INVALID_ARRIVAL: [400, 'Invalid arrivalAt, expected an ISO date-time'],
  SIM_DISABLED: [404, 'Not found'],
  SIM_FORBIDDEN: [403, 'Invalid simulator key']
};

export const toHttpError = (code: string) => errorTable[code];
