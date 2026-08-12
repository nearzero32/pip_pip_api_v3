import { describe, expect, test } from "bun:test";
import {
  assertTransition,
  assertOpsTransition,
  dashboardMayCancel,
} from "../../src/modules/orders/order-state-machine";

describe("M4-C2 cancel and restricted transitions", () => {
  test("dashboard may cancel non-terminal orders including post-pickup", () => {
    expect(dashboardMayCancel("PICKED_UP")).toBe(true);
    expect(dashboardMayCancel("ARRIVED_AT_CUSTOMER")).toBe(true);
    expect(dashboardMayCancel("CANCELLED")).toBe(false);
    expect(dashboardMayCancel("DELIVERED")).toBe(false);
  });

  test("reopen and handoff reset are ops-only", () => {
    expect(() =>
      assertTransition("CANCELLED", "PENDING_STORE_APPROVAL"),
    ).toThrow();
    expect(() =>
      assertOpsTransition("CANCELLED", "PENDING_STORE_APPROVAL"),
    ).not.toThrow();
    expect(() => assertTransition("ARRIVED_AT_CUSTOMER", "PICKED_UP")).toThrow();
    expect(() =>
      assertOpsTransition("ARRIVED_AT_CUSTOMER", "PICKED_UP"),
    ).not.toThrow();
    expect(() =>
      assertTransition("DRIVER_ASSIGNED", "SEARCHING_DRIVER"),
    ).toThrow();
    expect(() =>
      assertOpsTransition("DRIVER_ASSIGNED", "SEARCHING_DRIVER"),
    ).not.toThrow();
  });
});
