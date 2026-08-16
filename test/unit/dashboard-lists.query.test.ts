import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  dashboardListResult,
  dashboardPageOf,
  likeContains,
  parseAllowlistedSort,
  parseOptionalDateRange,
  parseOptionalSearch,
} from "../../src/modules/dashboard-lists/query";

describe("dashboard list query primitives", () => {
  test("defaults page 1 limit 25 and computes totalPages", () => {
    expect(dashboardPageOf()).toEqual({ page: 1, limit: 25 });
    expect(dashboardListResult([], 1, 25, 0).pagination.totalPages).toBe(0);
    expect(dashboardListResult([], 1, 25, 140).pagination.totalPages).toBe(6);
  });

  test("rejects invalid page and limit", () => {
    expect(() => dashboardPageOf(0, 25)).toThrow(AppError);
    expect(() => dashboardPageOf(1, 101)).toThrow(AppError);
  });

  test("trims search and escapes ILIKE wildcards", () => {
    expect(parseOptionalSearch("  محمد  ")).toBe("محمد");
    expect(parseOptionalSearch("   ")).toBeNull();
    expect(likeContains("100%_off")).toBe("%100\\%\\_off%");
  });

  test("allowlists sort fields", () => {
    expect(parseAllowlistedSort(undefined, ["createdAt", "name"] as const, "createdAt")).toBe(
      "createdAt",
    );
    expect(() => parseAllowlistedSort("password", ["createdAt"] as const, "createdAt")).toThrow(
      AppError,
    );
  });

  test("date-only ranges are Asia/Baghdad half-open [startOfDay, startOfNextDay)", () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const range = parseOptionalDateRange({
        from: "2026-08-01",
        to: "2026-08-01",
      });
      expect(range.from?.toISOString()).toBe("2026-07-31T21:00:00.000Z");
      expect(range.to?.toISOString()).toBe("2026-08-01T21:00:00.000Z");
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
    expect(() =>
      parseOptionalDateRange({ from: "2026-08-16", to: "2026-08-01" }),
    ).toThrow(AppError);
  });

  test("offset date-times are exclusive on to ([from, to))", () => {
    const offset = parseOptionalDateRange({
      from: "2026-08-01T00:00:00.000+03:00",
      to: "2026-08-02T00:00:00.000+03:00",
    });
    expect(offset.from?.toISOString()).toBe("2026-07-31T21:00:00.000Z");
    expect(offset.to?.toISOString()).toBe("2026-08-01T21:00:00.000Z");
    const utc = parseOptionalDateRange({
      from: "2026-07-31T21:00:00.000Z",
      to: "2026-08-01T21:00:00.000Z",
    });
    expect(utc.from?.toISOString()).toBe("2026-07-31T21:00:00.000Z");
    expect(utc.to?.toISOString()).toBe("2026-08-01T21:00:00.000Z");
  });
});
