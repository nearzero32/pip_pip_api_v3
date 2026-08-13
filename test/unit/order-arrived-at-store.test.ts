import { describe, expect, test } from "bun:test";
import {
  assignmentLifecycleStatus,
  orderEventType,
  orderStatus,
} from "../../src/db/schema/enums";
import { ORDER_COMMAND_SCOPES } from "../../src/modules/orders/order-command-idempotency";
import {
  assertTransition,
  mayConfirmArrivalAtStore,
  mayConfirmPickup,
  mayMarkReady,
} from "../../src/modules/orders/order-state-machine";

describe("arrived at store unit gates", () => {
  test("ARRIVED_AT_STORE exists on order, assignment, and event enums", () => {
    expect(orderStatus.enumValues).toContain("ARRIVED_AT_STORE");
    expect(assignmentLifecycleStatus.enumValues).toContain("ARRIVED_AT_STORE");
    expect(orderEventType.enumValues).toContain("DRIVER_ARRIVED_AT_STORE");
    expect(ORDER_COMMAND_SCOPES.confirmArrivalAtStore).toBe(
      "v1:orders.confirm-arrival-at-store",
    );
  });

  test("driver may arrive from DRIVER_ASSIGNED or READY_FOR_PICKUP", () => {
    expect(mayConfirmArrivalAtStore("DRIVER_ASSIGNED")).toBe(true);
    expect(mayConfirmArrivalAtStore("READY_FOR_PICKUP")).toBe(true);
    assertTransition("DRIVER_ASSIGNED", "ARRIVED_AT_STORE");
    assertTransition("READY_FOR_PICKUP", "ARRIVED_AT_STORE");
  });

  test("driver cannot arrive from PICKED_UP or CANCELLED", () => {
    expect(mayConfirmArrivalAtStore("PICKED_UP")).toBe(false);
    expect(mayConfirmArrivalAtStore("CANCELLED")).toBe(false);
  });

  test("mark-ready after arrival stays on ARRIVED_AT_STORE naturally", () => {
    expect(mayMarkReady("ARRIVED_AT_STORE")).toBe(true);
    expect(() =>
      assertTransition("ARRIVED_AT_STORE", "READY_FOR_PICKUP"),
    ).toThrow();
  });

  test("pickup requires ARRIVED_AT_STORE status (ready+arrival timestamps enforced in service)", () => {
    expect(mayConfirmPickup("ARRIVED_AT_STORE")).toBe(true);
    expect(mayConfirmPickup("READY_FOR_PICKUP")).toBe(false);
    expect(mayConfirmPickup("DRIVER_ASSIGNED")).toBe(false);
    assertTransition("ARRIVED_AT_STORE", "PICKED_UP");
  });
});
