import { AppError } from "../../errors/app-error";

export const STORE_TIMEZONE = "Asia/Baghdad";

export const WEEKDAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export type WorkingHourPeriod = {
  dayOfWeek: Weekday;
  /** Local wall-clock HH:MM or HH:MM:SS */
  opensAt: string;
  closesAt: string;
};

export type ScheduleAvailability = {
  isOpen: boolean;
  nextOpeningAt: string | null;
  nextClosingAt: string | null;
};

const WEEKDAY_INDEX: Record<Weekday, number> = {
  MONDAY: 0,
  TUESDAY: 1,
  WEDNESDAY: 2,
  THURSDAY: 3,
  FRIDAY: 4,
  SATURDAY: 5,
  SUNDAY: 6,
};

const INDEX_WEEKDAY = WEEKDAYS;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export const parseClockToMinutes = (raw: string): number => {
  const match = TIME_RE.exec(raw.trim());
  if (!match) {
    throw new AppError(422, "INVALID_WORKING_HOURS", "Invalid working hours");
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
};

export const formatMinutes = (total: number): string => {
  const hours = Math.floor(total / 60) % 24;
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

export const normalizeClock = (raw: string): string =>
  formatMinutes(parseClockToMinutes(raw));

/** Same-day overlap including overnight segments. */
export const periodsOverlapSameDay = (
  a: WorkingHourPeriod,
  b: WorkingHourPeriod,
): boolean => {
  if (a.dayOfWeek !== b.dayOfWeek) return false;
  const aOpen = parseClockToMinutes(a.opensAt);
  const aClose = parseClockToMinutes(a.closesAt);
  const bOpen = parseClockToMinutes(b.opensAt);
  const bClose = parseClockToMinutes(b.closesAt);

  const segments = (open: number, close: number): Array<[number, number]> => {
    if (open === close) {
      throw new AppError(422, "INVALID_WORKING_HOURS", "Invalid working hours");
    }
    if (close > open) return [[open, close]];
    // Overnight: [open, 1440) U [0, close)
    return [
      [open, 1440],
      [0, close],
    ];
  };

  const aSegs = segments(aOpen, aClose);
  const bSegs = segments(bOpen, bClose);
  for (const [as, ae] of aSegs) {
    for (const [bs, be] of bSegs) {
      if (as < be && bs < ae) return true;
    }
  }
  return false;
};

export const validateWorkingHours = (
  periods: WorkingHourPeriod[],
): WorkingHourPeriod[] => {
  const normalized = periods.map((period) => {
    if (!WEEKDAYS.includes(period.dayOfWeek)) {
      throw new AppError(422, "INVALID_WORKING_HOURS", "Invalid working hours");
    }
    const opensAt = normalizeClock(period.opensAt);
    const closesAt = normalizeClock(period.closesAt);
    if (opensAt === closesAt) {
      throw new AppError(
        422,
        "INVALID_WORKING_HOURS",
        "Working hours cannot use equal open and close times",
      );
    }
    return { dayOfWeek: period.dayOfWeek, opensAt, closesAt };
  });

  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (periodsOverlapSameDay(normalized[i]!, normalized[j]!)) {
        throw new AppError(
          422,
          "WORKING_HOURS_OVERLAP",
          "Working hours periods overlap",
        );
      }
    }
  }
  return normalized;
};

type AbsoluteInterval = { start: Date; end: Date };

const baghdadParts = (
  instant: Date,
): { weekday: Weekday; minutes: number; y: number; m: number; d: number } => {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: STORE_TIMEZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const weekdayMap: Record<string, Weekday> = {
    Mon: "MONDAY",
    Tue: "TUESDAY",
    Wed: "WEDNESDAY",
    Thu: "THURSDAY",
    Fri: "FRIDAY",
    Sat: "SATURDAY",
    Sun: "SUNDAY",
  };
  const weekday = weekdayMap[parts.weekday!];
  if (!weekday) {
    throw new AppError(500, "INTERNAL_ERROR", "Failed to resolve local weekday");
  }
  return {
    weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
  };
};

/** Construct a Date for a Baghdad wall-clock civil date + minutes. */
const baghdadInstant = (
  y: number,
  m: number,
  d: number,
  minutes: number,
): Date => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  // Asia/Baghdad is fixed UTC+3 (no DST).
  const utcMs = Date.UTC(y, m - 1, d, hours - 3, mins, 0, 0);
  return new Date(utcMs);
};

const addDaysCivil = (
  y: number,
  m: number,
  d: number,
  delta: number,
): { y: number; m: number; d: number } => {
  const utc = new Date(Date.UTC(y, m - 1, d + delta));
  return {
    y: utc.getUTCFullYear(),
    m: utc.getUTCMonth() + 1,
    d: utc.getUTCDate(),
  };
};

const expandIntervals = (
  periods: WorkingHourPeriod[],
  around: Date,
): AbsoluteInterval[] => {
  const base = baghdadParts(around);
  const intervals: AbsoluteInterval[] = [];
  // Cover previous day overnight into today, and next ~8 days for nextOpening.
  for (let offset = -1; offset <= 8; offset++) {
    const civil = addDaysCivil(base.y, base.m, base.d, offset);
    const weekday =
      INDEX_WEEKDAY[(WEEKDAY_INDEX[base.weekday] + offset + 70) % 7]!;
    for (const period of periods) {
      if (period.dayOfWeek !== weekday) continue;
      const openMin = parseClockToMinutes(period.opensAt);
      const closeMin = parseClockToMinutes(period.closesAt);
      const start = baghdadInstant(civil.y, civil.m, civil.d, openMin);
      if (closeMin > openMin) {
        intervals.push({
          start,
          end: baghdadInstant(civil.y, civil.m, civil.d, closeMin),
        });
      } else {
        const next = addDaysCivil(civil.y, civil.m, civil.d, 1);
        intervals.push({
          start,
          end: baghdadInstant(next.y, next.m, next.d, closeMin),
        });
      }
    }
  }
  return intervals.sort((a, b) => a.start.getTime() - b.start.getTime());
};

const toOffsetIso = (value: Date): string => {
  // Always render with Asia/Baghdad +03:00 wall offset.
  const parts = baghdadParts(value);
  const hh = String(Math.floor(parts.minutes / 60)).padStart(2, "0");
  const mm = String(parts.minutes % 60).padStart(2, "0");
  const month = String(parts.m).padStart(2, "0");
  const day = String(parts.d).padStart(2, "0");
  return `${parts.y}-${month}-${day}T${hh}:${mm}:00+03:00`;
};

/**
 * Deterministic schedule evaluation against a supplied instant (not wall clock).
 * Date-specific overrides are intentionally out of scope for M3-D0.
 */
export const evaluateStoreSchedule = (
  periods: WorkingHourPeriod[],
  now: Date,
): ScheduleAvailability => {
  if (periods.length === 0) {
    return { isOpen: false, nextOpeningAt: null, nextClosingAt: null };
  }
  const intervals = expandIntervals(periods, now);
  const nowMs = now.getTime();
  const active = intervals.find(
    (interval) =>
      nowMs >= interval.start.getTime() && nowMs < interval.end.getTime(),
  );
  if (active) {
    return {
      isOpen: true,
      nextOpeningAt: null,
      nextClosingAt: toOffsetIso(active.end),
    };
  }
  const next = intervals.find((interval) => interval.start.getTime() > nowMs);
  return {
    isOpen: false,
    nextOpeningAt: next ? toOffsetIso(next.start) : null,
    nextClosingAt: null,
  };
};

export const computeIsAcceptingOrders = (input: {
  status: string;
  orderAcceptanceStatus: string;
  isOpen: boolean;
}): boolean =>
  input.status === "ACTIVE" &&
  input.orderAcceptanceStatus === "ACCEPTING" &&
  input.isOpen;
