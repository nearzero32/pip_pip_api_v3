import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SPIN_RANK,
  rankOffersForSpin,
  rotationScore,
} from "../../src/modules/driver-offers/spin-rank";
import type { OpenOfferSummary } from "../../src/modules/driver-offers/driver-runtime";

const base = (i: number, openedAt: string): OpenOfferSummary => ({
  offerId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  orderId: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  cityId: "20000000-0000-4000-8000-000000000001",
  openedAt,
  pricingBaseSnapshot: 1000,
  roundingUnitSnapshot: 250,
  pricingStagesSnapshot: [{ afterSeconds: 0, increasePercentage: 0 }],
  pricingVersionSnapshot: 1,
});

describe("spin ranking", () => {
  test("caps at five and prefers older age buckets", () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const offers = [
      base(1, "2026-01-01T00:09:50.000Z"),
      base(2, "2026-01-01T00:09:40.000Z"),
      base(3, "2026-01-01T00:08:00.000Z"),
      base(4, "2026-01-01T00:07:00.000Z"),
      base(5, "2026-01-01T00:06:00.000Z"),
      base(6, "2026-01-01T00:05:00.000Z"),
      base(7, "2026-01-01T00:04:00.000Z"),
    ];
    const ranked = rankOffersForSpin(offers, "driver-a", now, DEFAULT_SPIN_RANK);
    expect(ranked).toHaveLength(5);
    // Oldest age buckets first — offer 7 opened earliest
    expect(ranked[0]!.offerId).toBe(base(7, "").offerId);
  });

  test("different drivers get different sets within the same oldest bucket", () => {
    const now = new Date("2026-01-01T00:01:00.000Z");
    // All within one 60s age bucket relative to now
    const offers = Array.from({ length: 8 }, (_, i) =>
      base(i + 1, new Date(now.getTime() - 10_000 - i * 100).toISOString()),
    );
    const a = rankOffersForSpin(offers, "driver-aaa", now, DEFAULT_SPIN_RANK).map(
      (o) => o.offerId,
    );
    const b = rankOffersForSpin(offers, "driver-bbb", now, DEFAULT_SPIN_RANK).map(
      (o) => o.offerId,
    );
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(a.join(",")).not.toBe(b.join(","));
  });

  test("same driver same window is stable; new window reshuffles deterministically", () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const t1 = new Date(t0.getTime() + 14_000);
    const t2 = new Date(t0.getTime() + 16_000);
    const offers = Array.from({ length: 8 }, (_, i) =>
      base(i + 1, new Date(t0.getTime() - 5_000 - i * 50).toISOString()),
    );
    const first = rankOffersForSpin(offers, "driver-stable", t0, DEFAULT_SPIN_RANK).map(
      (o) => o.offerId,
    );
    const sameWindow = rankOffersForSpin(
      offers,
      "driver-stable",
      t1,
      DEFAULT_SPIN_RANK,
    ).map((o) => o.offerId);
    const nextWindow = rankOffersForSpin(
      offers,
      "driver-stable",
      t2,
      DEFAULT_SPIN_RANK,
    ).map((o) => o.offerId);
    expect(first).toEqual(sameWindow);
    expect(nextWindow.join(",")).not.toBe(first.join(","));
    expect(
      rotationScore("driver-stable", offers[0]!.offerId, Math.floor(t0.getTime() / 15_000)),
    ).toBe(
      rotationScore("driver-stable", offers[0]!.offerId, Math.floor(t1.getTime() / 15_000)),
    );
  });
});
