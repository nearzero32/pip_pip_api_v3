import { describe, expect, test } from "bun:test";
import {
  dashboardCancelBlockedByDriverCustody,
  dashboardMayCancel,
} from "../../src/modules/orders/order-state-machine";

describe("M4-C1 temporary cancel gate", () => {
  test("blocks dashboard cancel once custody is with driver or post-pickup status", () => {
    expect(
      dashboardCancelBlockedByDriverCustody({
        status: "PICKED_UP",
        custodyStatus: "WITH_DRIVER",
      }),
    ).toBe(true);
    expect(
      dashboardCancelBlockedByDriverCustody({
        status: "ARRIVED_AT_CUSTOMER",
        custodyStatus: "WITH_DRIVER",
      }),
    ).toBe(true);
    expect(
      dashboardCancelBlockedByDriverCustody({
        status: "READY_FOR_PICKUP",
        custodyStatus: "WITH_DRIVER",
      }),
    ).toBe(true);
    expect(
      dashboardCancelBlockedByDriverCustody({
        status: "DRIVER_ASSIGNED",
        custodyStatus: "WITH_STORE",
      }),
    ).toBe(false);
    expect(dashboardMayCancel("PICKED_UP")).toBe(true);
  });
});
