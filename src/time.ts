export const BOGOTA_OFFSET_MINUTES = -300;
export const SLOT_MINUTES = 15;
export const DAY_MS = 86_400_000;

const OFFSET_MS = BOGOTA_OFFSET_MINUTES * 60_000;
const SLOT_MS = SLOT_MINUTES * 60_000;
const pad = (value: number) => String(value).padStart(2, '0');

export const bogotaLocalSql = (column: string) => `(${column} AT TIME ZONE interval '-05:00')`;

export function bogotaParts(date: Date) {
  const local = new Date(date.getTime() + OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    weekday: local.getUTCDay()
  };
}

export const slotStart = (date: Date) => new Date(Math.floor(date.getTime() / SLOT_MS) * SLOT_MS);

export function slotLabel(date: Date) {
  const { hour, minute } = bogotaParts(date);
  return `${pad(hour)}:${pad(minute - (minute % SLOT_MINUTES))}`;
}

export const allSlotLabels = () => Array.from({ length: (24 * 60) / SLOT_MINUTES }, (_, index) => {
  const minutes = index * SLOT_MINUTES;
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
});

export function bogotaDate(date: Date) {
  const { year, month, day } = bogotaParts(date);
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function bogotaMidnight(isoDate: string) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - OFFSET_MS);
}

export const isValidIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && bogotaDate(bogotaMidnight(value)) === value;

export const weekdayOfIsoDate = (isoDate: string) => bogotaParts(bogotaMidnight(isoDate)).weekday;

export function bogotaMonthStart(date: Date) {
  const { year, month } = bogotaParts(date);
  return new Date(Date.UTC(year, month - 1, 1) - OFFSET_MS);
}

export function bogotaMonthLabel(date: Date) {
  const { year, month } = bogotaParts(date);
  return `${year}-${pad(month)}`;
}
