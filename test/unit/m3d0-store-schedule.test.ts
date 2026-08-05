import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  computeIsAcceptingOrders,
  evaluateStoreSchedule,
  periodsOverlapSameDay,
  validateWorkingHours,
  type WorkingHourPeriod,
} from "../../src/modules/stores/schedule";

/** Asia/Baghdad fixed +03:00 — construct instants from local wall clock. */
const baghdad = (
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
): Date => new Date(Date.UTC(y, m - 1, d, hh - 3, mm, 0, 0));

describe("M3-D0 Store schedule engine", () => {
  test("rejects equal open and close times", () => {
    expect(() =>
      validateWorkingHours([
        { dayOfWeek: "MONDAY", opensAt: "00:00", closesAt: "00:00" },
      ]),
    ).toThrow(AppError);
  });

  test("rejects overlapping same-day intervals", () => {
    expect(() =>
      validateWorkingHours([
        { dayOfWeek: "SATURDAY", opensAt: "09:00", closesAt: "14:00" },
        { dayOfWeek: "SATURDAY", opensAt: "13:00", closesAt: "18:00" },
      ]),
    ).toThrow(AppError);
    try {
      validateWorkingHours([
        { dayOfWeek: "SATURDAY", opensAt: "09:00", closesAt: "14:00" },
        { dayOfWeek: "SATURDAY", opensAt: "13:00", closesAt: "18:00" },
      ]);
    } catch (error) {
      expect((error as AppError).publicCode).toBe("WORKING_HOURS_OVERLAP");
    }
  });

  test("allows multiple non-overlapping same-day intervals", () => {
    const hours = validateWorkingHours([
      { dayOfWeek: "SATURDAY", opensAt: "09:00", closesAt: "14:00" },
      { dayOfWeek: "SATURDAY", opensAt: "16:00", closesAt: "23:00" },
    ]);
    expect(hours).toHaveLength(2);
  });

  test("allows overnight intervals", () => {
    const hours = validateWorkingHours([
      { dayOfWeek: "SATURDAY", opensAt: "18:00", closesAt: "02:00" },
    ]);
    expect(hours[0]).toEqual({
      dayOfWeek: "SATURDAY",
      opensAt: "18:00",
      closesAt: "02:00",
    });
  });

  test("overnight segments overlap detection across midnight split", () => {
    expect(
      periodsOverlapSameDay(
        { dayOfWeek: "FRIDAY", opensAt: "22:00", closesAt: "02:00" },
        { dayOfWeek: "FRIDAY", opensAt: "01:00", closesAt: "03:00" },
      ),
    ).toBe(true);
  });

  test("closed day with no periods yields not open and no next opening when empty", () => {
    expect(evaluateStoreSchedule([], baghdad(2026, 8, 5, 12, 0))).toEqual({
      isOpen: false,
      nextOpeningAt: null,
      nextClosingAt: null,
    });
  });

  test("single interval open and nextClosingAt", () => {
    const periods: WorkingHourPeriod[] = [
      { dayOfWeek: "WEDNESDAY", opensAt: "09:00", closesAt: "17:00" },
    ];
    // 2026-08-05 is Wednesday
    const result = evaluateStoreSchedule(periods, baghdad(2026, 8, 5, 12, 0));
    expect(result.isOpen).toBe(true);
    expect(result.nextOpeningAt).toBeNull();
    expect(result.nextClosingAt).toBe("2026-08-05T17:00:00+03:00");
  });

  test("exact opening instant is open", () => {
    const periods: WorkingHourPeriod[] = [
      { dayOfWeek: "WEDNESDAY", opensAt: "09:00", closesAt: "17:00" },
    ];
    const result = evaluateStoreSchedule(periods, baghdad(2026, 8, 5, 9, 0));
    expect(result.isOpen).toBe(true);
    expect(result.nextClosingAt).toBe("2026-08-05T17:00:00+03:00");
  });

  test("exact closing instant is closed with nextOpeningAt", () => {
    const periods: WorkingHourPeriod[] = [
      { dayOfWeek: "WEDNESDAY", opensAt: "09:00", closesAt: "17:00" },
      { dayOfWeek: "THURSDAY", opensAt: "09:00", closesAt: "17:00" },
    ];
    const result = evaluateStoreSchedule(periods, baghdad(2026, 8, 5, 17, 0));
    expect(result.isOpen).toBe(false);
    expect(result.nextClosingAt).toBeNull();
    expect(result.nextOpeningAt).toBe("2026-08-06T09:00:00+03:00");
  });

  test("overnight Saturday covers early Sunday morning", () => {
    const periods: WorkingHourPeriod[] = [
      { dayOfWeek: "SATURDAY", opensAt: "18:00", closesAt: "02:00" },
    ];
    // 2026-08-08 Saturday, 2026-08-09 Sunday
    expect(
      evaluateStoreSchedule(periods, baghdad(2026, 8, 8, 20, 0)).isOpen,
    ).toBe(true);
    const sundayEarly = evaluateStoreSchedule(
      periods,
      baghdad(2026, 8, 9, 1, 0),
    );
    expect(sundayEarly.isOpen).toBe(true);
    expect(sundayEarly.nextClosingAt).toBe("2026-08-09T02:00:00+03:00");
    expect(
      evaluateStoreSchedule(periods, baghdad(2026, 8, 9, 2, 0)).isOpen,
    ).toBe(false);
  });

  test("midnight boundary for same-day period ending at 00:00 is overnight into next day", () => {
    // 22:00 → 00:00 means overnight to midnight (next civil day 00:00)
    const periods: WorkingHourPeriod[] = [
      { dayOfWeek: "MONDAY", opensAt: "22:00", closesAt: "00:00" },
    ];
    // 2026-08-03 Monday
    expect(
      evaluateStoreSchedule(periods, baghdad(2026, 8, 3, 23, 30)).isOpen,
    ).toBe(true);
    expect(
      evaluateStoreSchedule(periods, baghdad(2026, 8, 4, 0, 0)).isOpen,
    ).toBe(false);
  });

  test("week boundary: Sunday overnight into Monday", () => {
    const periods: WorkingHourPeriod[] = [
      { dayOfWeek: "SUNDAY", opensAt: "20:00", closesAt: "02:00" },
    ];
    // 2026-08-09 Sunday, 2026-08-10 Monday
    expect(
      evaluateStoreSchedule(periods, baghdad(2026, 8, 9, 23, 0)).isOpen,
    ).toBe(true);
    expect(
      evaluateStoreSchedule(periods, baghdad(2026, 8, 10, 1, 0)).isOpen,
    ).toBe(true);
    expect(
      evaluateStoreSchedule(periods, baghdad(2026, 8, 10, 2, 0)).isOpen,
    ).toBe(false);
  });

  test("nextOpeningAt when currently closed", () => {
    const periods: WorkingHourPeriod[] = [
      { dayOfWeek: "WEDNESDAY", opensAt: "09:00", closesAt: "17:00" },
    ];
    const result = evaluateStoreSchedule(periods, baghdad(2026, 8, 5, 8, 0));
    expect(result.isOpen).toBe(false);
    expect(result.nextOpeningAt).toBe("2026-08-05T09:00:00+03:00");
    expect(result.nextClosingAt).toBeNull();
  });

  test("computeIsAcceptingOrders combines status, pause, and schedule", () => {
    expect(
      computeIsAcceptingOrders({
        status: "ACTIVE",
        orderAcceptanceStatus: "ACCEPTING",
        isOpen: true,
      }),
    ).toBe(true);
    expect(
      computeIsAcceptingOrders({
        status: "ACTIVE",
        orderAcceptanceStatus: "ACCEPTING",
        isOpen: false,
      }),
    ).toBe(false);
    expect(
      computeIsAcceptingOrders({
        status: "ACTIVE",
        orderAcceptanceStatus: "PAUSED",
        isOpen: true,
      }),
    ).toBe(false);
    expect(
      computeIsAcceptingOrders({
        status: "INACTIVE",
        orderAcceptanceStatus: "ACCEPTING",
        isOpen: true,
      }),
    ).toBe(false);
  });
});
