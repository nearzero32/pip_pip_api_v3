import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  parseIqdPrice,
  validateAvailabilityWindows,
} from "../../src/modules/catalog/product-availability";

describe("Product availability & IQD price helpers", () => {
  test("accepts positive integer IQD prices", () => {
    expect(parseIqdPrice(8000, "basePrice")).toBe(8000);
  });

  test("rejects non-integer and non-positive prices", () => {
    expect(() => parseIqdPrice(12.5)).toThrow(AppError);
    expect(() => parseIqdPrice(0)).toThrow(AppError);
    expect(() => parseIqdPrice(-1)).toThrow(AppError);
    expect(() => parseIqdPrice("1000")).toThrow(AppError);
  });

  test("rejects cross-midnight and equal open/close windows", () => {
    expect(() =>
      validateAvailabilityWindows([
        { dayOfWeek: "SATURDAY", opensAt: "22:00", closesAt: "02:00" },
      ]),
    ).toThrow(AppError);
    expect(() =>
      validateAvailabilityWindows([
        { dayOfWeek: "MONDAY", opensAt: "09:00", closesAt: "09:00" },
      ]),
    ).toThrow(AppError);
  });

  test("allows multiple non-overlapping same-day windows", () => {
    const windows = validateAvailabilityWindows([
      { dayOfWeek: "SATURDAY", opensAt: "06:00", closesAt: "11:00" },
      { dayOfWeek: "SATURDAY", opensAt: "17:00", closesAt: "22:00" },
    ]);
    expect(windows).toHaveLength(2);
  });

  test("rejects overlapping same-day windows", () => {
    expect(() =>
      validateAvailabilityWindows([
        { dayOfWeek: "FRIDAY", opensAt: "09:00", closesAt: "14:00" },
        { dayOfWeek: "FRIDAY", opensAt: "13:00", closesAt: "18:00" },
      ]),
    ).toThrow(AppError);
    try {
      validateAvailabilityWindows([
        { dayOfWeek: "FRIDAY", opensAt: "09:00", closesAt: "14:00" },
        { dayOfWeek: "FRIDAY", opensAt: "13:00", closesAt: "18:00" },
      ]);
    } catch (error) {
      expect((error as AppError).publicCode).toBe(
        "PRODUCT_AVAILABILITY_OVERLAP",
      );
    }
  });
});
