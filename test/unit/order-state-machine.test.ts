import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import {
  assertTransition,
  assertOpsTransition,
  customerMayCancel,
  dashboardMayCancel,
  isTerminalStatus,
  mayApprove,
  mayMarkReady,
  mayConfirmArrival,
  mayConfirmDelivery,
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

  test("rejects skipping and reverse transitions on natural path", () => {
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

  test("natural path rejects C2-only skip and handoff-reset transitions", () => {
    expect(() =>
      assertTransition("SEARCHING_DRIVER", "READY_FOR_PICKUP"),
    ).toThrow(AppError);
    expect(() =>
      assertTransition("ARRIVED_AT_CUSTOMER", "PICKED_UP"),
    ).toThrow(AppError);
    expect(() =>
      assertTransition("DRIVER_ASSIGNED", "SEARCHING_DRIVER"),
    ).toThrow(AppError);
    expect(() =>
      assertTransition("CANCELLED", "PENDING_STORE_APPROVAL"),
    ).toThrow(AppError);
  });

  test("ops path allows C2-only transitions", () => {
    expect(() =>
      assertOpsTransition("SEARCHING_DRIVER", "READY_FOR_PICKUP"),
    ).not.toThrow();
    expect(() =>
      assertOpsTransition("ARRIVED_AT_CUSTOMER", "PICKED_UP"),
    ).not.toThrow();
    expect(() =>
      assertOpsTransition("DRIVER_ASSIGNED", "SEARCHING_DRIVER"),
    ).not.toThrow();
    expect(() =>
      assertOpsTransition("CANCELLED", "PENDING_STORE_APPROVAL"),
    ).not.toThrow();
    expect(() =>
      assertOpsTransition("PICKED_UP", "READY_FOR_PICKUP"),
    ).not.toThrow();
  });

  test("merchant mark-ready and driver delivery gates cannot use C2 skips", () => {
    expect(mayMarkReady("SEARCHING_DRIVER")).toBe(false);
    expect(mayMarkReady("DRIVER_ASSIGNED")).toBe(true);
    expect(mayConfirmArrival("ARRIVED_AT_CUSTOMER")).toBe(false);
    expect(mayConfirmDelivery("PICKED_UP")).toBe(false);
    expect(mayConfirmDelivery("ARRIVED_AT_CUSTOMER")).toBe(true);
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
