import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DASHBOARD_LIST_ENDPOINTS,
  type DashboardListEndpoint,
} from "../../src/modules/dashboard-lists/inventory";
import {
  createIntegrationHarness,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";
import { seedDashboardListWorld } from "./dashboard-list-fixture";

const password = "fixed staff password";

/**
 * Guards against regression to the unstructured AppError contract:
 * { code: "VALIDATION_FAILED", message: "The request is invalid" }
 * without details — previously returned by dashboard query parsers.
 */
describe("dashboard list validation contract inventory", () => {
  let h: IntegrationHarness;
  let superToken = "";
  let adminToken = "";
  let cityA = "";
  let storeId = "";
  let orderId = "";

  const resolve = (template: string) =>
    template
      .replaceAll(":storeId", storeId)
      .replaceAll(":orderId", orderId)
      .replaceAll(":cityId", cityA);

  const tokenOf = (ep: DashboardListEndpoint) =>
    ep.actor === "super" ? superToken : adminToken;

  beforeAll(async () => {
    h = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_dash_val_inv",
    });
    const world = await seedDashboardListWorld(h, password);
    cityA = world.cityA;
    storeId = world.storeId;
    orderId = world.orderId;
    superToken = world.superToken;
    adminToken = world.adminToken;
  });

  afterAll(async () => {
    await h.close();
  });

  test("no dashboard list returns generic VALIDATION_FAILED without details", async () => {
    const failures: string[] = [];
    for (const ep of DASHBOARD_LIST_ENDPOINTS) {
      const path = `${resolve(ep.pathTemplate)}?sortBy=__not_a_sort_field__`;
      const response = await h.app.handle(
        jsonRequest(path, { token: tokenOf(ep) }),
      );
      const text = await response.text();
      let body: {
        error?: { code?: string; message?: string; details?: unknown };
      };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        failures.push(`${ep.pathTemplate}: non-JSON ${response.status}`);
        continue;
      }
      if (response.status !== 422) {
        failures.push(
          `${ep.pathTemplate}: expected 422 got ${response.status}`,
        );
        continue;
      }
      if (
        body.error?.code === "VALIDATION_FAILED" &&
        body.error.message === "The request is invalid"
      ) {
        failures.push(`${ep.pathTemplate}: generic message without details`);
      }
      if (body.error?.message === "The request is invalid") {
        failures.push(`${ep.pathTemplate}: message still generic`);
      }
      if (!body.error?.details) {
        failures.push(`${ep.pathTemplate}: missing details`);
      }
      if (text.includes("__not_a_sort_field__")) {
        failures.push(`${ep.pathTemplate}: leaked invalid sort value`);
      }
    }
    expect(failures).toEqual([]);
  });
});
