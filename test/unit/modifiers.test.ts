import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  assertDefaultsWithinMaxSelect,
  parseIqdNonNegativePrice,
  parseMaxQuantity,
  parseMinMaxSelect,
} from "../../src/modules/catalog/modifier-validation";

describe("Modifier validation helpers", () => {
  test("accepts zero and positive IQD prices", () => {
    expect(parseIqdNonNegativePrice(0)).toBe(0);
    expect(parseIqdNonNegativePrice(1500)).toBe(1500);
  });

  test("rejects negative and non-integer prices", () => {
    expect(() => parseIqdNonNegativePrice(-1)).toThrow(AppError);
    expect(() => parseIqdNonNegativePrice(1.5)).toThrow(AppError);
  });

  test("validates maxQuantity as positive integer", () => {
    expect(parseMaxQuantity(1)).toBe(1);
    expect(() => parseMaxQuantity(0)).toThrow(AppError);
  });

  test("validates minSelect/maxSelect combinations", () => {
    expect(parseMinMaxSelect(0, 1)).toEqual({ minSelect: 0, maxSelect: 1 });
    expect(parseMinMaxSelect(2, 3)).toEqual({ minSelect: 2, maxSelect: 3 });
    expect(() => parseMinMaxSelect(3, 2)).toThrow(AppError);
    expect(() => parseMinMaxSelect(0, 0)).toThrow(AppError);
  });

  test("rejects defaults exceeding maxSelect", () => {
    expect(() => assertDefaultsWithinMaxSelect(3, 2)).toThrow(AppError);
    assertDefaultsWithinMaxSelect(2, 2);
  });
});
