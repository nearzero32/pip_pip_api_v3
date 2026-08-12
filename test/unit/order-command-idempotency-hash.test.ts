import { describe, expect, test } from "bun:test";
import { hashOrderCommandPayload } from "../../src/modules/orders/order-command-idempotency";

describe("hashOrderCommandPayload", () => {
  test("canonical key sort makes object key order irrelevant", () => {
    expect(hashOrderCommandPayload({ b: 1, a: 2 })).toBe(
      hashOrderCommandPayload({ a: 2, b: 1 }),
    );
  });

  test("nested objects are sorted recursively", () => {
    expect(
      hashOrderCommandPayload({ z: { b: 1, a: 2 }, y: [3, { d: 4, c: 5 }] }),
    ).toBe(
      hashOrderCommandPayload({ y: [3, { c: 5, d: 4 }], z: { a: 2, b: 1 } }),
    );
  });
});
