import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  COLLECTION_AMOUNT_MAX,
  assertCollectedMeetsExpected,
  expectedCollectionAmountOf,
  parseCollectedAmount,
} from "../../src/modules/orders/order-collection";

describe("order collection amounts", () => {
  test("parseCollectedAmount requires a non-negative integer IQD value", () => {
    expect(parseCollectedAmount(0)).toBe(0);
    expect(parseCollectedAmount(25000)).toBe(25000);
    expect(parseCollectedAmount(COLLECTION_AMOUNT_MAX)).toBe(COLLECTION_AMOUNT_MAX);
    expect(() => parseCollectedAmount(undefined)).toThrow(AppError);
    expect(() => parseCollectedAmount(null)).toThrow(AppError);
    try {
      parseCollectedAmount(undefined);
    } catch (error) {
      expect((error as AppError).publicCode).toBe("COLLECTED_AMOUNT_REQUIRED");
    }
    for (const raw of [
      "27000",
      27.5,
      NaN,
      Infinity,
      -1,
      COLLECTION_AMOUNT_MAX + 1,
      true,
      {},
    ]) {
      try {
        parseCollectedAmount(raw);
        throw new Error(`expected invalid: ${String(raw)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).publicCode).toBe("COLLECTED_AMOUNT_INVALID");
      }
    }
  });

  test("assertCollectedMeetsExpected rejects shortfalls with safe metadata", () => {
    assertCollectedMeetsExpected(25000, 25000);
    assertCollectedMeetsExpected(27000, 25000);
    try {
      assertCollectedMeetsExpected(24000, 25000);
      throw new Error("expected shortfall");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const err = error as AppError;
      expect(err.publicCode).toBe("COLLECTED_AMOUNT_BELOW_EXPECTED");
      expect(err.statusCode).toBe(409);
      expect(err.details).toEqual({
        expectedCollectionAmount: 25000,
        collectedAmount: 24000,
        shortfallAmount: 1000,
      });
    }
  });

  test("expectedCollectionAmountOf rejects non-integer totals", () => {
    expect(expectedCollectionAmountOf(0)).toBe(0);
    expect(expectedCollectionAmountOf(3250)).toBe(3250);
    expect(() => expectedCollectionAmountOf(null)).toThrow(AppError);
    expect(() => expectedCollectionAmountOf(12.3)).toThrow(AppError);
    try {
      expectedCollectionAmountOf(undefined);
    } catch (error) {
      expect((error as AppError).publicCode).toBe(
        "ORDER_EXPECTED_COLLECTION_UNAVAILABLE",
      );
    }
  });
});
