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

  test("date-only ranges use Asia/Baghdad inclusive bounds", () => {
    const range = parseOptionalDateRange({
      from: "2026-08-01",
      to: "2026-08-01",
    });
    expect(range.from?.toISOString()).toBe("2026-07-31T21:00:00.000Z");
    expect(range.to?.toISOString()).toBe("2026-08-01T20:59:59.999Z");
    expect(() =>
      parseOptionalDateRange({ from: "2026-08-16", to: "2026-08-01" }),
    ).toThrow(AppError);
  });
});
