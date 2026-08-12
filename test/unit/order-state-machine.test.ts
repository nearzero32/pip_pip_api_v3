import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  assertTransition,
  customerMayCancel,
  dashboardMayCancel,
  isTerminalStatus,
  mayApprove,
  mayMutateItems,
  mayReplaceItems,
} from "../../src/modules/orders/order-state-machine";

describe("order state machine", () => {
  test("allows the official happy-path transitions", () => {
    assertTransition("PENDING_STORE_APPROVAL", "SEARCHING_DRIVER");
    assertTransition("SEARCHING_DRIVER", "DRIVER_ASSIGNED");
    assertTransition("DRIVER_ASSIGNED", "READY_FOR_PICKUP");
    assertTransition("READY_FOR_PICKUP", "PICKED_UP");
    assertTransition("PICKED_UP", "ARRIVED_AT_CUSTOMER");
    assertTransition("ARRIVED_AT_CUSTOMER", "DELIVERED");
  });

  test("rejects skipping and reverse transitions", () => {
    expect(() => assertTransition("PENDING_STORE_APPROVAL", "DRIVER_ASSIGNED")).toThrow(
      AppError,
    );
    expect(() => assertTransition("APPROVED_BY_STORE", "PENDING_STORE_APPROVAL")).toThrow(
      AppError,
    );
    expect(() => assertTransition("DELIVERED", "CANCELLED")).toThrow(AppError);
    expect(() => assertTransition("PICKED_UP", "SEARCHING_DRIVER")).toThrow(AppError);
    expect(() => assertTransition("CANCELLED", "DELIVERED")).toThrow(AppError);
  });

  test("allows admin reopen and reoffer transitions", () => {
    expect(() =>
      assertTransition("CANCELLED", "PENDING_STORE_APPROVAL"),
    ).not.toThrow();
    expect(() => assertTransition("DRIVER_ASSIGNED", "SEARCHING_DRIVER")).not.toThrow();
    expect(() =>
      assertTransition("ARRIVED_AT_CUSTOMER", "PICKED_UP"),
    ).not.toThrow();
    expect(() =>
      assertTransition("SEARCHING_DRIVER", "READY_FOR_PICKUP"),
    ).not.toThrow();
  });

  test("cancellation and replacement preconditions", () => {
    expect(customerMayCancel("PENDING_STORE_APPROVAL")).toBe(true);
    expect(customerMayCancel("APPROVED_BY_STORE")).toBe(false);
    expect(dashboardMayCancel("APPROVED_BY_STORE")).toBe(true);
    expect(dashboardMayCancel("DELIVERED")).toBe(false);
    expect(mayReplaceItems("PENDING_STORE_APPROVAL")).toBe(true);
    expect(mayMutateItems("DRIVER_ASSIGNED")).toBe(true);
    expect(mayReplaceItems("READY_FOR_PICKUP")).toBe(false);
    expect(mayApprove("PENDING_STORE_APPROVAL")).toBe(true);
    expect(mayApprove("APPROVED_BY_STORE")).toBe(false);
    expect(isTerminalStatus("DELIVERED")).toBe(true);
    expect(isTerminalStatus("CANCELLED")).toBe(true);
  });

  test("invalid transitions use ORDER_INVALID_TRANSITION", () => {
    try {
      assertTransition("PICKED_UP", "PENDING_STORE_APPROVAL");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toMatchObject({ publicCode: "ORDER_INVALID_TRANSITION", statusCode: 409 });
    }
  });
});
