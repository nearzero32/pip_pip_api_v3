import { AppError } from "../../errors/app-error";

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

export type AvailabilityWindow = {
  dayOfWeek: Weekday;
  opensAt: string;
  closesAt: string;
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export const parseClockToMinutes = (raw: string): number => {
  const match = TIME_RE.exec(raw.trim());
  if (!match) {
    throw new AppError(
      422,
      "INVALID_PRODUCT_AVAILABILITY",
      "Invalid availability window",
    );
  }
  return Number(match[1]) * 60 + Number(match[2]);
};

export const formatMinutes = (total: number): string => {
  const hours = Math.floor(total / 60) % 24;
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

export const parseIqdPrice = (raw: unknown, field = "price"): number => {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw <= 0 ||
    !Number.isSafeInteger(raw)
  ) {
    throw new AppError(422, "VALIDATION_FAILED", `Invalid ${field}`);
  }
  return raw;
};

/** Same-day windows only; start < end; reject overlaps on the same weekday. */
export const validateAvailabilityWindows = (
  windows: AvailabilityWindow[],
): AvailabilityWindow[] => {
  const normalized = windows.map((window) => {
    if (!WEEKDAYS.includes(window.dayOfWeek)) {
      throw new AppError(
        422,
        "INVALID_PRODUCT_AVAILABILITY",
        "Invalid availability window",
      );
    }
    const open = parseClockToMinutes(window.opensAt);
    const close = parseClockToMinutes(window.closesAt);
    if (close <= open) {
      throw new AppError(
        422,
        "INVALID_PRODUCT_AVAILABILITY",
        "Availability windows cannot cross midnight; use two windows",
      );
    }
    return {
      dayOfWeek: window.dayOfWeek,
      opensAt: formatMinutes(open),
      closesAt: formatMinutes(close),
    };
  });

  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i]!;
      const b = normalized[j]!;
      if (a.dayOfWeek !== b.dayOfWeek) continue;
      const aOpen = parseClockToMinutes(a.opensAt);
      const aClose = parseClockToMinutes(a.closesAt);
      const bOpen = parseClockToMinutes(b.opensAt);
      const bClose = parseClockToMinutes(b.closesAt);
      if (aOpen < bClose && bOpen < aClose) {
        throw new AppError(
          422,
          "PRODUCT_AVAILABILITY_OVERLAP",
          "Availability windows overlap",
        );
      }
    }
  }
  return normalized;
};
