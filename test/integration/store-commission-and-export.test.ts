import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";
import { reopenExcelWorkbook } from "../../src/modules/dashboard-export/xlsx";

const password = "fixed staff password";

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error;

const login = async (harness: IntegrationHarness, email: string, requestId: string) =>
  harness.auth.dashboard.login({
    email,
    password,
    deviceName: requestId,
    ip: requestId,
    requestId,
  });

const grant = async (
  harness: IntegrationHarness,
  adminToken: string,
  employeeId: string,
  permissions: string[],
) => {
  for (const permission of permissions) {
    const status = (
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/employees/${employeeId}/permissions`, {
          method: "POST",
          token: adminToken,
          body: { permission },
        }),
      )
    ).status;
    expect([200, 409]).toContain(status);
  }
};

const xlsxRowCount = (bytes: Uint8Array) =>
  reopenExcelWorkbook(bytes).dataRowCount;

const revoke = async (
  harness: IntegrationHarness,
  adminToken: string,
  employeeId: string,
  permission: string,
) => {
  const status = (
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/employees/${employeeId}/permissions/${permission}`,
        { method: "DELETE", token: adminToken },
      ),
    )
  ).status;
  expect(status).toBe(200);
};

const snapshotOf = async (harness: IntegrationHarness, orderId: string) => {
  const [row] = await harness.client<{ store_commission_rate_snapshot: number }[]>`
    select store_commission_rate_snapshot from orders where id = ${orderId}`;
  return Number(row?.store_commission_rate_snapshot);
};

describe("store commission rates and dashboard Excel export", () => {
  let h: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let employeeId = "";
  let employeeToken = "";
  let storeId = "";
  let storeB = "";
  let productId = "";
  let zoneId = "";
  let customerId = "";
  let addressId = "";
  let adminAccountId = "";

  beforeAll(async () => {
    h = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_commission_export",
    });
    cityA = await createActiveCity(h.client, "Commission City A");
    cityB = await createActiveCity(h.client, "Commission City B");
    const superAccountId = await createStaffAccount(h.auth, h.client, {
      email: "super-commission@test.local",
      password,
      roles: ["SUPER_ADMIN"],
    });
    adminAccountId = await createStaffAccount(h.auth, h.client, {
      email: "admin-commission@test.local",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    await createStaffAccount(h.auth, h.client, {
      email: "admin-b-commission@test.local",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    employeeId = await createStaffAccount(h.auth, h.client, {
      email: "ops-commission@test.local",
      password,
      roles: ["OPERATIONS"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });
    superToken = (await login(h, "super-commission@test.local", "super-c")).access_token;
    adminToken = (await login(h, "admin-commission@test.local", "admin-c")).access_token;
    adminBToken = (await login(h, "admin-b-commission@test.local", "admin-b-c")).access_token;
    employeeToken = (await login(h, "ops-commission@test.local", "ops-c")).access_token;

    const [media] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${cityA}, 'CATEGORY_IMAGE', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'x.png',
        'image/png', 1, 'image/png', 1, ${adminAccountId}, now(), now(), now()
      ) returning id`;
    const [logo] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${cityA}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l.png',
        'image/png', 1, 'image/png', 1, ${adminAccountId}, now(), now(), now()
      ) returning id`;
    const [logoB] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${cityB}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'lb.png',
        'image/png', 1, 'image/png', 1, ${adminAccountId}, now(), now(), now()
      ) returning id`;
    const [mediaB] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${cityB}, 'CATEGORY_IMAGE', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'xb.png',
        'image/png', 1, 'image/png', 1, ${adminAccountId}, now(), now(), now()
      ) returning id`;
    const [cat] = await h.client<{ id: string }[]>`
      insert into main_categories(city_id, name, image_asset_id, status, created_by_account_id)
      values (${cityA}, 'مطاعم', ${media!.id}, 'ACTIVE', ${adminAccountId}) returning id`;
    const [catB] = await h.client<{ id: string }[]>`
      insert into main_categories(city_id, name, image_asset_id, status, created_by_account_id)
      values (${cityB}, 'مطاعم', ${mediaB!.id}, 'ACTIVE', ${adminAccountId}) returning id`;
    const [s] = await h.client<{ id: string }[]>`
      insert into stores(
        city_id, main_category_id, name, phone, address, location, logo_asset_id,
        status, order_acceptance_status, created_by_account_id
      ) values (
        ${cityA}, ${cat!.id}, '=HYPERLINK("http://evil")', '+9647001111111', 'Address',
        ST_SetSRID(ST_MakePoint(44.4, 33.3), 4326), ${logo!.id},
        'ACTIVE', 'ACCEPTING', ${adminAccountId}
      ) returning id`;
    storeId = s!.id;
    const [sB] = await h.client<{ id: string }[]>`
      insert into stores(
        city_id, main_category_id, name, phone, address, location, logo_asset_id,
        status, order_acceptance_status, created_by_account_id
      ) values (
        ${cityB}, ${catB!.id}, 'Store B', '+9647002222222', 'Address',
        ST_SetSRID(ST_MakePoint(44.4, 33.3), 4326), ${logoB!.id},
        'ACTIVE', 'ACCEPTING', ${adminAccountId}
      ) returning id`;
    storeB = sB!.id;
    const [z] = await h.client<{ id: string }[]>`
      insert into zones(city_id, name, boundary, status)
      values (
        ${cityA}, 'Delivery',
        ST_GeomFromText('POLYGON((44 33,45 33,45 34,44 34,44 33))', 4326),
        'ACTIVE'
      ) returning id`;
    zoneId = z!.id;
    await h.client`insert into store_zones(store_id, zone_id, city_id) values (${storeId}, ${zoneId}, ${cityA})`;
    const [p] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${storeId}, ${cityA}, 'منتج', 1000, true, 'ACTIVE', ${adminAccountId}) returning id`;
    productId = p!.id;
    const superIdentity = {
      accountId: superAccountId,
      sessionId: null as unknown as string,
      applicationType: "DASHBOARD" as const,
      roles: ["SUPER_ADMIN"],
      scopeType: "GLOBAL" as const,
      cityId: null,
      storeId: null,
    };
    await h.deliveryPricing.create(superIdentity, cityA, {
      baseFee: 1000,
      includedDistanceMeters: 1000,
      pricePerKm: 500,
      roundingStep: 250,
      maximumDeliveryDistanceMeters: 50000,
      routingFallbackEnabled: true,
      fallbackOnNoRoute: true,
      fallbackOnProviderFailure: true,
      fallbackExtraDistanceMeters: 300,
    });
    const versions = await h.deliveryPricing.list(superIdentity, cityA);
    await h.deliveryPricing.activate(superIdentity, cityA, versions.data[0]!.id);
    h.routingProvider.setResult({ distanceMeters: 1000, durationSeconds: 120 });
    const [cust] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    customerId = cust!.id;
    await h.client`insert into customer_profiles(account_id) values (${customerId})`;
    const addr = await h.addresses.create(customerId, cityA, {
      label: "البيت",
      location: { latitude: 33.31, longitude: 44.41 },
      addressDetails: "تفاصيل",
    });
    addressId = addr.id;
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  test("store CRUD rejects commission fields and defaults rate to 0", async () => {
    const listed = await h.app.handle(
      jsonRequest("/api/v1/dashboard/stores", { token: adminToken }),
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { data: Array<{ id: string; platformCommissionRate?: number }> };
    expect(body.data[0]?.platformCommissionRate).toBeUndefined();
    const patch = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeId}`, {
        method: "PATCH",
        token: adminToken,
        body: { platformCommissionRate: 20 },
      }),
    );
    expect(patch.status).toBe(422);
  });

  test("commission page is independent of stores.read", async () => {
    await grant(h, adminToken, employeeId, ["stores.read"]);
    const denied = await h.app.handle(
      jsonRequest("/api/v1/dashboard/store-commissions", { token: employeeToken }),
    );
    expect(denied.status).toBe(403);
    await grant(h, adminToken, employeeId, ["stores.commission.read"]);
    const allowed = await h.app.handle(
      jsonRequest("/api/v1/dashboard/store-commissions", { token: employeeToken }),
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { pagination: { total: number }; data: Array<{ platformCommissionRate: number }> };
    expect(body.pagination.total).toBe(1);
    expect(body.data[0]?.platformCommissionRate).toBe(0);
  });

  test("SUPER_ADMIN cannot manage city store commissions", async () => {
    const response = await h.app.handle(
      jsonRequest("/api/v1/dashboard/store-commissions", { token: superToken }),
    );
    expect(response.status).toBe(403);
  });

  test("cross-city store id is 404 and cityId in body is rejected", async () => {
    const missing = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/store-commissions/${storeB}`, {
        token: adminToken,
      }),
    );
    expect(missing.status).toBe(404);
    const patched = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/store-commissions/${storeId}`, {
        method: "PATCH",
        token: adminToken,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: {
          platformCommissionRate: 15,
          reason: "اتفاق",
          cityId: cityB,
        },
      }),
    );
    expect(patched.status).toBe(422);
  });

  test("updates rate with history, idempotency, and no-op equal rate", async () => {
    const key = crypto.randomUUID();
    const first = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/store-commissions/${storeId}`, {
        method: "PATCH",
        token: adminToken,
        headers: { "Idempotency-Key": key },
        body: { platformCommissionRate: 15, reason: "تحديث الاتفاق مع المتجر" },
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      platformCommissionRate: number;
      updatedAt: string;
    };
    expect(firstBody.platformCommissionRate).toBe(15);
    const replay = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/store-commissions/${storeId}`, {
        method: "PATCH",
        token: adminToken,
        headers: { "Idempotency-Key": key },
        body: { platformCommissionRate: 15, reason: "تحديث الاتفاق مع المتجر" },
      }),
    );
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { updatedAt: string }).updatedAt).toBe(
      firstBody.updatedAt,
    );
    const reused = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/store-commissions/${storeId}`, {
        method: "PATCH",
        token: adminToken,
        headers: { "Idempotency-Key": key },
        body: { platformCommissionRate: 20, reason: "تحديث الاتفاق مع المتجر" },
      }),
    );
    expect(reused.status).toBe(409);
    expect((await errorOf(reused)).code).toBe("IDEMPOTENCY_KEY_REUSED");
    const sameRate = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/store-commissions/${storeId}`, {
        method: "PATCH",
        token: adminToken,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: { platformCommissionRate: 15, reason: "نفس النسبة" },
      }),
    );
    expect(sameRate.status).toBe(200);
    const history = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/store-commissions/${storeId}/history`, {
        token: adminToken,
      }),
    );
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as { pagination: { total: number }; data: Array<{ previousRate: number; newRate: number }> };
    expect(historyBody.pagination.total).toBe(1);
    expect(historyBody.data[0]?.previousRate).toBe(0);
    expect(historyBody.data[0]?.newRate).toBe(15);
    await expectDatabaseRejection(
      h.client`update store_commission_rate_history set reason = 'x'`,
    );
  });

  test("order create snapshots the current store rate and later rate changes do not rewrite it", async () => {
    const order = await h.orders.create(customerId, cityA, {
      storeId,
      addressId,
      paymentMethod: "CASH",
      items: [{ productId, quantity: 1 }],
      idempotencyKey: crypto.randomUUID(),
    });
    const [snap] = await h.client<{ store_commission_rate_snapshot: number }[]>`
      select store_commission_rate_snapshot from orders where id = ${order.id}`;
    expect(Number(snap?.store_commission_rate_snapshot)).toBe(15);
    const replay = await h.orders.create(customerId, cityA, {
      storeId,
      addressId,
      paymentMethod: "CASH",
      items: [{ productId, quantity: 1 }],
      idempotencyKey: "same-order-key",
    });
    await h.app.handle(
      jsonRequest(`/api/v1/dashboard/store-commissions/${storeId}`, {
        method: "PATCH",
        token: adminToken,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: { platformCommissionRate: 40, reason: "اتفاق جديد" },
      }),
    );
    const replayed = await h.orders.create(customerId, cityA, {
      storeId,
      addressId,
      paymentMethod: "CASH",
      items: [{ productId, quantity: 1 }],
      idempotencyKey: "same-order-key",
    });
    expect(replayed.id).toBe(replay.id);
    const [unchanged] = await h.client<{ store_commission_rate_snapshot: number }[]>`
      select store_commission_rate_snapshot from orders where id = ${replay.id}`;
    expect(Number(unchanged?.store_commission_rate_snapshot)).toBe(15);
    const fresh = await h.orders.create(customerId, cityA, {
      storeId,
      addressId,
      paymentMethod: "CASH",
      items: [{ productId, quantity: 1 }],
      idempotencyKey: crypto.randomUUID(),
    });
    const [freshSnap] = await h.client<{ store_commission_rate_snapshot: number }[]>`
      select store_commission_rate_snapshot from orders where id = ${fresh.id}`;
    expect(Number(freshSnap?.store_commission_rate_snapshot)).toBe(40);
  });

  test("export requires read+export and matches list filters", async () => {
    const storesList = await h.app.handle(
      jsonRequest("/api/v1/dashboard/stores", { token: adminToken }),
    );
    const listed = (await storesList.json()) as { pagination: { total: number } };
    const storesExport = await h.app.handle(
      jsonRequest("/api/v1/dashboard/stores/export", { token: adminToken }),
    );
    expect(storesExport.status).toBe(200);
    expect(storesExport.headers.get("content-type")).toContain(
      "spreadsheetml.sheet",
    );
    const storeBytes = new Uint8Array(await storesExport.arrayBuffer());
    expect(xlsxRowCount(storeBytes)).toBe(listed.pagination.total);
    expect(new TextDecoder().decode(storeBytes)).toContain("&apos;=HYPERLINK");

    const commissionList = await h.app.handle(
      jsonRequest("/api/v1/dashboard/store-commissions", { token: adminToken }),
    );
    const commissionTotal = ((await commissionList.json()) as { pagination: { total: number } }).pagination.total;
    await grant(h, adminToken, employeeId, ["stores.commission.read"]);
    const exportDenied = await h.app.handle(
      jsonRequest("/api/v1/dashboard/store-commissions/export", {
        token: employeeToken,
      }),
    );
    expect(exportDenied.status).toBe(403);
    await grant(h, adminToken, employeeId, ["stores.commission.export"]);
    const commissionExport = await h.app.handle(
      jsonRequest("/api/v1/dashboard/store-commissions/export", {
        token: employeeToken,
      }),
    );
    expect(commissionExport.status).toBe(200);
    expect(xlsxRowCount(new Uint8Array(await commissionExport.arrayBuffer()))).toBe(
      commissionTotal,
    );

    const superCity = await h.app.handle(
      jsonRequest("/api/v1/dashboard/stores/export", { token: superToken }),
    );
    expect(superCity.status).toBe(403);
    const otherCity = await h.app.handle(
      jsonRequest("/api/v1/dashboard/stores/export", { token: adminBToken }),
    );
    expect(otherCity.status).toBe(200);
    expect(xlsxRowCount(new Uint8Array(await otherCity.arrayBuffer()))).toBe(1);

    const govExport = await h.app.handle(
      jsonRequest("/api/v1/dashboard/governorates/export", {
        token: superToken,
      }),
    );
    expect(govExport.status).toBe(200);
    const govAdmin = await h.app.handle(
      jsonRequest("/api/v1/dashboard/governorates/export", {
        token: adminToken,
      }),
    );
    expect(govAdmin.status).toBe(403);
  });

  test("OpenAPI documents commission and export paths without emptying other request bodies", async () => {
    const response = await h.app.handle(
      new Request("http://localhost/openapi/json"),
    );
    expect(response.status).toBe(200);
    const doc = (await response.json()) as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };
    const required = [
      "/api/v1/dashboard/store-commissions",
      "/api/v1/dashboard/store-commissions/{storeId}",
      "/api/v1/dashboard/store-commissions/{storeId}/history",
      "/api/v1/dashboard/stores/export",
      "/api/v1/dashboard/store-commissions/export",
      "/api/v1/dashboard/store-commission-history/export",
      "/api/v1/dashboard/orders/export",
      "/api/v1/dashboard/governorates/export",
      "/api/v1/mobile/customer/cart/items",
    ];
    for (const path of required) expect(doc.paths[path]).toBeTruthy();
    expect(
      JSON.stringify(doc.paths["/api/v1/mobile/customer/cart/items"]?.post?.requestBody),
    ).toContain("sizeId");
    const exportPaths = Object.keys(doc.paths)
      .filter((path) => path.includes("/export"))
      .sort();
    expect(exportPaths).toEqual([
      "/api/v1/dashboard/admins/export",
      "/api/v1/dashboard/cities/export",
      "/api/v1/dashboard/cities/{cityId}/delivery-pricing/versions/export",
      "/api/v1/dashboard/drivers/assignment-candidates/export",
      "/api/v1/dashboard/employees/export",
      "/api/v1/dashboard/governorates/export",
      "/api/v1/dashboard/main-categories/export",
      "/api/v1/dashboard/merchants/export",
      "/api/v1/dashboard/order-assignments/export",
      "/api/v1/dashboard/order-collections/export",
      "/api/v1/dashboard/order-events/export",
      "/api/v1/dashboard/order-handoffs/export",
      "/api/v1/dashboard/order-offer-rounds/export",
      "/api/v1/dashboard/order-returns/export",
      "/api/v1/dashboard/orders/export",
      "/api/v1/dashboard/orders/{orderId}/offer-rounds/export",
      "/api/v1/dashboard/store-commission-history/export",
      "/api/v1/dashboard/store-commissions/export",
      "/api/v1/dashboard/stores/export",
      "/api/v1/dashboard/stores/{storeId}/categories/export",
      "/api/v1/dashboard/stores/{storeId}/modifier-groups/export",
      "/api/v1/dashboard/stores/{storeId}/products/export",
      "/api/v1/dashboard/subcategories/export",
      "/api/v1/dashboard/zones/export",
    ]);
    expect(doc.paths["/api/v1/dashboard/export"]).toBeUndefined();
  });

  test("global export permissions are independent of read and not grantable to employees", async () => {
    const grantGlobal = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/employees/${employeeId}/permissions`, {
        method: "POST",
        token: adminToken,
        body: { permission: "governorates.export" },
      }),
    );
    expect(grantGlobal.status).toBe(422);
    expect(
      (
        await h.app.handle(
          jsonRequest("/api/v1/dashboard/governorates/export", {
            token: employeeToken,
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.app.handle(
          jsonRequest("/api/v1/dashboard/cities/export", { token: adminToken }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.app.handle(
          jsonRequest("/api/v1/dashboard/admins/export", { token: superToken }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await h.app.handle(
          jsonRequest(
            `/api/v1/dashboard/cities/${cityA}/delivery-pricing/versions/export`,
            { token: superToken },
          ),
        )
      ).status,
    ).toBe(200);
  });

  test("commission history export is independent of list export", async () => {
    await grant(h, adminToken, employeeId, [
      "stores.commission.read",
      "stores.commission.export",
    ]);
    expect(
      (
        await h.app.handle(
          jsonRequest("/api/v1/dashboard/store-commission-history/export", {
            token: employeeToken,
          }),
        )
      ).status,
    ).toBe(403);
    await grant(h, adminToken, employeeId, [
      "stores.commission.history.export",
    ]);
    const allowed = await h.app.handle(
      jsonRequest("/api/v1/dashboard/store-commission-history/export", {
        token: employeeToken,
      }),
    );
    expect(allowed.status).toBe(200);
    await revoke(h, adminToken, employeeId, "stores.commission.history.export");
    expect(
      (
        await h.app.handle(
          jsonRequest("/api/v1/dashboard/store-commission-history/export", {
            token: employeeToken,
          }),
        )
      ).status,
    ).toBe(403);
  });

  test("successful export writes one append-only audit row", async () => {
    await h.client`
      delete from audit_logs
      where actor_account_id = ${adminAccountId}
        and event_type = 'DASHBOARD_EXPORT'`;
    const denied = await h.app.handle(
      jsonRequest("/api/v1/dashboard/stores/export", { token: employeeToken }),
    );
    expect(denied.status).toBe(403);
    const before = await h.client<{ count: string }[]>`
      select count(*)::text as count from audit_logs
      where actor_account_id = ${adminAccountId} and event_type = 'DASHBOARD_EXPORT'`;
    expect(Number(before[0]?.count)).toBe(0);
    const exported = await h.app.handle(
      jsonRequest("/api/v1/dashboard/stores/export", { token: adminToken }),
    );
    expect(exported.status).toBe(200);
    const rows = await h.client<
      {
        actor_account_id: string;
        target_type: string;
        outcome: string;
        resource: string;
        endpoint: string;
        export_type: string;
        permission: string;
        filename: string;
        row_count: number;
        scope: string;
        city_id: string;
      }[]
    >`select actor_account_id::text, target_type, outcome::text,
             redacted_metadata->>'resource' as resource,
             redacted_metadata->>'endpoint' as endpoint,
             redacted_metadata->>'exportType' as export_type,
             redacted_metadata->>'permission' as permission,
             redacted_metadata->>'filename' as filename,
             (redacted_metadata->>'rowCount')::int as row_count,
             redacted_metadata->>'scope' as scope,
             redacted_metadata->>'cityId' as city_id
      from audit_logs
      where actor_account_id = ${adminAccountId}
        and event_type = 'DASHBOARD_EXPORT'
      order by occurred_at desc`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target_type).toBe("stores");
    expect(rows[0]?.outcome).toBe("SUCCESS");
    expect(rows[0]?.actor_account_id).toBe(adminAccountId);
    expect(rows[0]?.resource).toBe("stores");
    expect(rows[0]?.endpoint).toBe("/api/v1/dashboard/stores/export");
    expect(rows[0]?.export_type).toBe("xlsx");
    expect(rows[0]?.permission).toBe("stores.export");
    expect(rows[0]?.filename).toBe("stores.xlsx");
    expect(rows[0]?.row_count).toBe(
      xlsxRowCount(new Uint8Array(await exported.arrayBuffer())),
    );
    expect(rows[0]?.scope).toBe("CITY");
    expect(rows[0]?.city_id).toBe(cityA);
  });

  test("list and export share filters across dashboard resources", async () => {
    const cases = [
      {
        list: "/api/v1/dashboard/stores?search=evil&limit=1",
        exp: "/api/v1/dashboard/stores/export?search=evil",
        token: adminToken,
      },
      {
        list: "/api/v1/dashboard/stores?status=ACTIVE&limit=1",
        exp: "/api/v1/dashboard/stores/export?status=ACTIVE",
        token: adminToken,
      },
      {
        list: "/api/v1/dashboard/store-commissions?status=ACTIVE&limit=1",
        exp: "/api/v1/dashboard/store-commissions/export?status=ACTIVE",
        token: adminToken,
      },
      {
        list: "/api/v1/dashboard/zones?limit=1",
        exp: "/api/v1/dashboard/zones/export",
        token: adminToken,
      },
      {
        list: "/api/v1/dashboard/orders?limit=1",
        exp: "/api/v1/dashboard/orders/export",
        token: adminToken,
      },
      {
        list: "/api/v1/dashboard/main-categories?limit=1",
        exp: "/api/v1/dashboard/main-categories/export",
        token: adminToken,
      },
      {
        list: "/api/v1/dashboard/governorates?status=ACTIVE&limit=1",
        exp: "/api/v1/dashboard/governorates/export?status=ACTIVE",
        token: superToken,
      },
      {
        list: `/api/v1/dashboard/cities?status=ACTIVE&limit=1`,
        exp: "/api/v1/dashboard/cities/export?status=ACTIVE",
        token: superToken,
      },
    ];
    for (const item of cases) {
      const listed = await h.app.handle(
        jsonRequest(item.list, { token: item.token }),
      );
      expect(listed.status).toBe(200);
      const total = ((await listed.json()) as { pagination: { total: number } }).pagination.total;
      const exported = await h.app.handle(
        jsonRequest(item.exp, { token: item.token }),
      );
      expect(exported.status).toBe(200);
      const bytes = new Uint8Array(await exported.arrayBuffer());
      expect(reopenExcelWorkbook(bytes).dataRowCount).toBe(total);
    }
  });

  test("create order races with commission update without mixed snapshots", async () => {
    await h.app.handle(
      jsonRequest(`/api/v1/dashboard/store-commissions/${storeId}`, {
        method: "PATCH",
        token: adminToken,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: { platformCommissionRate: 12, reason: "قبل السباق" },
      }),
    );
    const [orderResult, rateResult] = await Promise.allSettled([
      h.orders.create(customerId, cityA, {
        storeId,
        addressId,
        paymentMethod: "CASH",
        items: [{ productId, quantity: 1 }],
        idempotencyKey: crypto.randomUUID(),
      }),
      h.app.handle(
        jsonRequest(`/api/v1/dashboard/store-commissions/${storeId}`, {
          method: "PATCH",
          token: adminToken,
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: { platformCommissionRate: 33, reason: "أثناء السباق" },
        }),
      ),
    ]);
    expect(orderResult.status).toBe("fulfilled");
    expect(rateResult.status).toBe("fulfilled");
    if (rateResult.status === "fulfilled")
      expect(rateResult.value.status).toBe(200);
    if (orderResult.status !== "fulfilled") throw new Error("order failed");
    const snapshot = await snapshotOf(h, orderResult.value.id);
    expect([12, 33]).toContain(snapshot);
    const [storeRate] = await h.client<{ platform_commission_rate: number }[]>`
      select platform_commission_rate from stores where id = ${storeId}`;
    expect([12, 33]).toContain(Number(storeRate?.platform_commission_rate));
    const history = await h.client<{ previous_rate: number; new_rate: number }[]>`
      select previous_rate, new_rate from store_commission_rate_history
      where store_id = ${storeId} order by changed_at asc, id asc`;
    for (const row of history) {
      expect(Number(row.previous_rate)).toBeGreaterThanOrEqual(0);
      expect(Number(row.new_rate)).toBeLessThanOrEqual(100);
    }
    const later = await snapshotOf(h, orderResult.value.id);
    expect(later).toBe(snapshot);
    const [item] = await h.client<{ id: string }[]>`
      select id::text from order_items where order_id = ${orderResult.value.id} limit 1`;
    const itemId = item!.id;
    const mutated = await h.app.handle(
      jsonRequest(
        `/api/v1/dashboard/orders/${orderResult.value.id}/items/${itemId}/quantity`,
        {
          method: "POST",
          token: adminToken,
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: { quantity: 2, reason: "تعديل كمية" },
        },
      ),
    );
    expect(mutated.status).toBe(200);
    expect(await snapshotOf(h, orderResult.value.id)).toBe(snapshot);
  });

  test("export permission matrix, city isolation, and no generic endpoint", async () => {
    const cityCases = [
      {
        path: "/api/v1/dashboard/zones/export",
        read: "zones.read",
        exp: "zones.export",
      },
      {
        path: "/api/v1/dashboard/stores/export",
        read: "stores.read",
        exp: "stores.export",
      },
      {
        path: "/api/v1/dashboard/orders/export",
        read: "orders.read",
        exp: "orders.export",
      },
      {
        path: "/api/v1/dashboard/main-categories/export",
        read: "main_categories.read",
        exp: "main_categories.export",
      },
    ];
    for (const item of cityCases) {
      await revoke(h, adminToken, employeeId, item.read).catch(() => undefined);
      await revoke(h, adminToken, employeeId, item.exp).catch(() => undefined);
      await grant(h, adminToken, employeeId, [item.read]);
      expect(
        (
          await h.app.handle(
            jsonRequest(item.path, { token: employeeToken }),
          )
        ).status,
      ).toBe(403);
      await revoke(h, adminToken, employeeId, item.read);
      await grant(h, adminToken, employeeId, [item.exp]);
      expect(
        (
          await h.app.handle(
            jsonRequest(item.path, { token: employeeToken }),
          )
        ).status,
      ).toBe(403);
      await grant(h, adminToken, employeeId, [item.read, item.exp]);
      expect(
        (
          await h.app.handle(
            jsonRequest(item.path, { token: employeeToken }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await h.app.handle(jsonRequest(item.path, { token: superToken }))
        ).status,
      ).toBe(403);
      await revoke(h, adminToken, employeeId, item.exp);
      expect(
        (
          await h.app.handle(
            jsonRequest(item.path, { token: employeeToken }),
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await h.app.handle(
          jsonRequest("/api/v1/dashboard/stores/export", {
            token: adminBToken,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await h.app.handle(
          jsonRequest("/api/v1/dashboard/export?table=orders", {
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(404);
  });
});

async function expectDatabaseRejection(operation: PromiseLike<unknown>) {
  let rejected = false;
  try {
    await operation;
  } catch {
    rejected = true;
  }
  expect(rejected).toBeTrue();
}
