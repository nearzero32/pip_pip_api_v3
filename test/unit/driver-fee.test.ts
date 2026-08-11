import { computeOfferedDriverFee, roundToNearestUnit, validatePricingStages } from "../../src/modules/driver-offers/driver-fee";
import { describe, expect, test } from "bun:test";

const stages = [
  { afterSeconds: 0, increasePercentage: 0 },
  { afterSeconds: 30, increasePercentage: 20 },
  { afterSeconds: 60, increasePercentage: 50 },
  { afterSeconds: 90, increasePercentage: 100 },
];

describe("driver fee math", () => {
  test("rounds midpoint up to nearest unit", () => {
    expect(roundToNearestUnit(1125, 250)).toBe(1250);
    expect(roundToNearestUnit(1000, 250)).toBe(1000);
    expect(roundToNearestUnit(1124, 250)).toBe(1000);
  });

  test("stage at second 0 uses base", () => {
    const openedAt = new Date("2026-01-01T00:00:00.000Z");
    const { offeredDriverFee, stage } = computeOfferedDriverFee({
      pricingBase: 1000,
      roundingUnit: 250,
      pricingStages: stages,
      openedAt,
      now: openedAt,
    });
    expect(stage.afterSeconds).toBe(0);
    expect(offeredDriverFee).toBe(1000);
  });

  test("boundaries before and after stage transitions", () => {
    const openedAt = new Date("2026-01-01T00:00:00.000Z");
    const at29 = computeOfferedDriverFee({
      pricingBase: 1000,
      roundingUnit: 250,
      pricingStages: stages,
      openedAt,
      now: new Date(openedAt.getTime() + 29_000),
    });
    expect(at29.stage.afterSeconds).toBe(0);
    expect(at29.offeredDriverFee).toBe(1000);

    const at30 = computeOfferedDriverFee({
      pricingBase: 1000,
      roundingUnit: 250,
      pricingStages: stages,
      openedAt,
      now: new Date(openedAt.getTime() + 30_000),
    });
    expect(at30.stage.afterSeconds).toBe(30);
    expect(at30.offeredDriverFee).toBe(1250);

    const at59 = computeOfferedDriverFee({
      pricingBase: 1000,
      roundingUnit: 250,
      pricingStages: stages,
      openedAt,
      now: new Date(openedAt.getTime() + 59_000),
    });
    expect(at59.stage.afterSeconds).toBe(30);

    const at60 = computeOfferedDriverFee({
      pricingBase: 1000,
      roundingUnit: 250,
      pricingStages: stages,
      openedAt,
      now: new Date(openedAt.getTime() + 60_000),
    });
    expect(at60.stage.afterSeconds).toBe(60);
    expect(at60.offeredDriverFee).toBe(1500);
  });

  test("last stage continues without expiry", () => {
    const openedAt = new Date("2026-01-01T00:00:00.000Z");
    const late = computeOfferedDriverFee({
      pricingBase: 1000,
      roundingUnit: 250,
      pricingStages: stages,
      openedAt,
      now: new Date(openedAt.getTime() + 3_600_000),
    });
    expect(late.stage.afterSeconds).toBe(90);
    expect(late.offeredDriverFee).toBe(2000);
  });

  test("rejects invalid stages", () => {
    expect(() => validatePricingStages([])).toThrow();
    expect(() =>
      validatePricingStages([{ afterSeconds: 10, increasePercentage: 0 }]),
    ).toThrow();
    expect(() =>
      validatePricingStages([
        { afterSeconds: 0, increasePercentage: 0 },
        { afterSeconds: 0, increasePercentage: 10 },
      ]),
    ).toThrow();
  });
});
