import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  assertTransition,
  customerMayCancel,
  dashboardMayCancel,
  isTerminalStatus,
  mayApprove,
  mayReplaceItems,
} from "../../src/modules/orders/order-state-machine";

describe("order state machine", () => {
  test("allows the official happy-path transitions", () => {
    assertTransition("UNDER_STORE_REVIEW", "APPROVED_BY_STORE");
    assertTransition("APPROVED_BY_STORE", "SEARCHING_DRIVER");
    assertTransition("SEARCHING_DRIVER", "DRIVER_ASSIGNED");
    assertTransition("DRIVER_ASSIGNED", "READY_FOR_PICKUP");
    assertTransition("READY_FOR_PICKUP", "ACCEPTED_BY_DRIVER");
    assertTransition("ACCEPTED_BY_DRIVER", "PICKED_UP");
    assertTransition("PICKED_UP", "ARRIVED_AT_CUSTOMER");
    assertTransition("ARRIVED_AT_CUSTOMER", "DELIVERED");
  });

  test("rejects skipping and reverse transitions", () => {
    expect(() => assertTransition("UNDER_STORE_REVIEW", "SEARCHING_DRIVER")).toThrow(
      AppError,
    );
    expect(() => assertTransition("APPROVED_BY_STORE", "UNDER_STORE_REVIEW")).toThrow(
      AppError,
    );
    expect(() => assertTransition("DELIVERED", "CANCELLED")).toThrow(AppError);
    expect(() => assertTransition("CANCELLED", "UNDER_STORE_REVIEW")).toThrow(
      AppError,
    );
  });

  test("cancellation and replacement preconditions", () => {
    expect(customerMayCancel("UNDER_STORE_REVIEW")).toBe(true);
    expect(customerMayCancel("APPROVED_BY_STORE")).toBe(false);
    expect(dashboardMayCancel("APPROVED_BY_STORE")).toBe(true);
    expect(dashboardMayCancel("DELIVERED")).toBe(false);
    expect(mayReplaceItems("UNDER_STORE_REVIEW")).toBe(true);
    expect(mayReplaceItems("APPROVED_BY_STORE")).toBe(false);
    expect(mayApprove("UNDER_STORE_REVIEW")).toBe(true);
    expect(mayApprove("APPROVED_BY_STORE")).toBe(false);
    expect(isTerminalStatus("DELIVERED")).toBe(true);
    expect(isTerminalStatus("CANCELLED")).toBe(true);
  });

  test("invalid transitions use ORDER_INVALID_STATE", () => {
    try {
      assertTransition("PICKED_UP", "UNDER_STORE_REVIEW");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toMatchObject({ publicCode: "ORDER_INVALID_STATE", statusCode: 409 });
    }
  });
});
