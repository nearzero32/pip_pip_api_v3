import { describe, expect, test } from "bun:test";
import {
  dashboardMayCancel,
  assertTransition,
} from "../../src/modules/orders/order-state-machine";

describe("M4-C2 cancel and reopen transitions", () => {
  test("dashboard may cancel non-terminal orders including post-pickup", () => {
    expect(dashboardMayCancel("PICKED_UP")).toBe(true);
    expect(dashboardMayCancel("ARRIVED_AT_CUSTOMER")).toBe(true);
    expect(dashboardMayCancel("CANCELLED")).toBe(false);
    expect(dashboardMayCancel("DELIVERED")).toBe(false);
  });

  test("allows reopen and handoff reset transitions", () => {
    expect(() =>
      assertTransition("CANCELLED", "PENDING_STORE_APPROVAL"),
    ).not.toThrow();
    expect(() => assertTransition("CANCELLED", "SEARCHING_DRIVER")).not.toThrow();
    expect(() =>
      assertTransition("ARRIVED_AT_CUSTOMER", "PICKED_UP"),
    ).not.toThrow();
    expect(() =>
      assertTransition("DRIVER_ASSIGNED", "SEARCHING_DRIVER"),
    ).not.toThrow();
  });
});
