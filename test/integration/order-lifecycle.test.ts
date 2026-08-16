// @ts-nocheck
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AuthIdentity } from "../../src/modules/auth/sessions/session-service";
import { driverContext } from "../../src/modules/auth/core/context";
import {
  createActiveCity,
  createDriverAccount,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const pricingInput = {
  baseFee: 1000,
  includedDistanceMeters: 1000,
  pricePerKm: 500,
  roundingStep: 250,
  maximumDeliveryDistanceMeters: 50000,
  routingFallbackEnabled: true,
  fallbackOnNoRoute: true,
  fallbackOnProviderFailure: true,
  fallbackExtraDistanceMeters: 300,
};

describe("M4-C1 order lifecycle", () => {
  let h: IntegrationHarness;
  let city = "";
  let city2 = "";
  let store = "";
  let store2 = "";
  let product = "";
  let product2 = "";
  let productAlt = "";
  let customer = "";
  let addressId = "";
  let merchantId = "";
  let merchantIdentity!: AuthIdentity;
  let merchant2Identity!: AuthIdentity;
  let adminIdentity!: AuthIdentity;
  let adminToken = "";
  let opsIdentity!: AuthIdentity;
  let opsNoPermIdentity!: AuthIdentity;
  let superIdentity!: AuthIdentity;
  let driverId = "";
  let driver2Id = "";
  let driverToken = "";
  let driver2Token = "";
  let merchantToken = "";
  let superId = "";

  const driverIdentity = (id: string, cityId: string): AuthIdentity => ({
    accountId: id,
    sessionId: null as unknown as string,
    applicationType: "DRIVER_APP",
    roles: [],
    scopeType: "CITY",
    cityId,
    storeId: null,
  });

  const createBody = (overrides: Record<string, unknown> = {}) => ({
    storeId: store,
    addressId,
    paymentMethod: "CASH" as const,
    items: [{ productId: product, quantity: 2 }],
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  });

  const putReadyProof = async (
    driverTok: string,
    orderId: string,
    assignmentId: string,
    purpose: "PICKUP_PROOF" | "DELIVERY_PROOF",
  ) => {
    const intentRes = await h.app.handle(
      jsonRequest(`/api/v1/mobile/driver/orders/${orderId}/proofs/upload-intent`, {
        token: driverTok,
        body: {
          assignmentId,
          purpose,
          contentType: "image/png",
          fileName: `${purpose.toLowerCase()}.png`,
          sizeBytes: PNG.length,
        },
      }),
    );
    expect(intentRes.status).toBe(200);
    const intent = (await intentRes.json()) as {
      fileId: string;
      upload: { url: string };
    };
    const objectKey = decodeURIComponent(
      intent.upload.url.split("/upload/")[1]!.split("?")[0]!,
    );
    h.mediaStorage.putObject(objectKey, "image/png", PNG);
    const confirmRes = await h.app.handle(
      jsonRequest(
        `/api/v1/mobile/driver/orders/${orderId}/proofs/${intent.fileId}/confirm`,
        { token: driverTok, method: "POST", body: {} },
      ),
    );
    expect(confirmRes.status).toBe(200);
    return intent.fileId;
  };

  beforeAll(async () => {
    h = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_lifecycle",
    });
    city = await createActiveCity(h.client, "Lifecycle City");
    city2 = await createActiveCity(h.client, "Lifecycle City 2");

    const [actor] = await h.client<{ id: string }[]>`
      insert into accounts default values returning id`;
    superId = actor!.id;
    superIdentity = {
      accountId: superId,
      sessionId: null as unknown as string,
      applicationType: "DASHBOARD",
      roles: ["SUPER_ADMIN"],
      scopeType: "GLOBAL",
      cityId: null,
      storeId: null,
    };

    const [media] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${city}, 'CATEGORY_IMAGE', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'x.png',
        'image/png', 1, 'image/png', 1, ${superId}, now(), now(), now()
      ) returning id`;
    const logos = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values
        (${city}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l1.png', 'image/png', 1, 'image/png', 1, ${superId}, now(), now(), now()),
        (${city}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l2.png', 'image/png', 1, 'image/png', 1, ${superId}, now(), now(), now())
      returning id`;
    const [cat] = await h.client<{ id: string }[]>`
      insert into main_categories(city_id, name, image_asset_id, status, created_by_account_id)
      values (${city}, 'مطاعم', ${media!.id}, 'ACTIVE', ${superId}) returning id`;
    const [s] = await h.client<{ id: string }[]>`
      insert into stores(
        city_id, main_category_id, name, phone, address, location, logo_asset_id,
        status, order_acceptance_status, created_by_account_id
      ) values (
        ${city}, ${cat!.id}, 'Store', '+9647001111111', 'Address',
        ST_SetSRID(ST_MakePoint(44.4, 33.3), 4326), ${logos[0]!.id},
        'ACTIVE', 'ACCEPTING', ${superId}
      ) returning id`;
    store = s!.id;
    const [s2] = await h.client<{ id: string }[]>`
      insert into stores(
        city_id, main_category_id, name, phone, address, location, logo_asset_id,
        status, order_acceptance_status, created_by_account_id
      ) values (
        ${city}, ${cat!.id}, 'Store 2', '+9647002222222', 'Address',
        ST_SetSRID(ST_MakePoint(44.41, 33.31), 4326), ${logos[1]!.id},
        'ACTIVE', 'ACCEPTING', ${superId}
      ) returning id`;
    store2 = s2!.id;
    const [z] = await h.client<{ id: string }[]>`
      insert into zones(city_id, name, boundary, status)
      values (
        ${city}, 'Delivery',
        ST_GeomFromText('POLYGON((44 33,45 33,45 34,44 34,44 33))', 4326),
        'ACTIVE'
      ) returning id`;
    await h.client`insert into store_zones(store_id, zone_id, city_id) values (${store}, ${z!.id}, ${city})`;
    await h.client`insert into store_zones(store_id, zone_id, city_id) values (${store2}, ${z!.id}, ${city})`;

    const [p] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${store}, ${city}, 'منتج', 1000, true, 'ACTIVE', ${superId}) returning id`;
    product = p!.id;
    const [p2] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${store}, ${city}, 'منتج 2', 1500, true, 'ACTIVE', ${superId}) returning id`;
    product2 = p2!.id;
    const [pAlt] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${store2}, ${city}, 'منتج متجر آخر', 1500, true, 'ACTIVE', ${superId}) returning id`;
    productAlt = pAlt!.id;

    await h.deliveryPricing.create(superIdentity, city, pricingInput);
    const versions = await h.deliveryPricing.list(superIdentity, city);
    await h.deliveryPricing.activate(superIdentity, city, versions.data[0]!.id);
    await h.cityDriverPricing.put(
      superIdentity,
      city,
      {
        pricingBase: 3000,
        roundingUnit: 250,
        pricingStages: [{ afterSeconds: 0, increasePercentage: 0 }],
      },
      "lifecycle-driver-pricing",
      crypto.randomUUID(),
    );
    h.routingProvider.setResult({ distanceMeters: 1000, durationSeconds: 120 });

    const [c] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    customer = c!.id;
    await h.client`insert into customer_profiles(account_id) values (${customer})`;
    const addr = await h.addresses.create(customer, city, {
      label: "البيت",
      location: { latitude: 33.31, longitude: 44.41 },
      addressDetails: "تفاصيل",
    });
    addressId = addr.id;

    const adminId = await createStaffAccount(h.auth, h.client, {
      email: "lifecycle-admin@example.com",
      password: "fixed dashboard password",
      roles: ["ADMIN"],
      cityId: city,
    });
    adminIdentity = {
      accountId: adminId,
      sessionId: null as unknown as string,
      applicationType: "DASHBOARD",
      roles: ["ADMIN"],
      scopeType: "CITY",
      cityId: city,
      storeId: null,
    };
    adminToken = (
      await h.auth.dashboard.login({
        email: "lifecycle-admin@example.com",
        password: "fixed dashboard password",
        deviceName: "lifecycle-admin",
        ip: "lifecycle-admin",
        requestId: "lifecycle-admin",
      })
    ).access_token;

    const opsId = await createStaffAccount(h.auth, h.client, {
      email: "lifecycle-ops@example.com",
      password: "fixed dashboard password",
      roles: ["OPERATIONS"],
      cityId: city,
      managedByAccountId: adminId,
    });
    for (const code of [
      "orders.read",
      "orders.approve",
      "orders.items.replace",
      "orders.items.mutate",
      "orders.lifecycle.override",
    ]) {
      await h.app.handle(
        jsonRequest(`/api/v1/dashboard/employees/${opsId}/permissions`, {
          token: adminToken,
          body: { permission: code },
        }),
      );
    }
    opsIdentity = {
      accountId: opsId,
      sessionId: null as unknown as string,
      applicationType: "DASHBOARD",
      roles: ["OPERATIONS"],
      scopeType: "CITY",
      cityId: city,
      storeId: null,
    };
    const opsNo = await createStaffAccount(h.auth, h.client, {
      email: "lifecycle-ops-none@example.com",
      password: "fixed dashboard password",
      roles: ["OPERATIONS"],
      cityId: city,
      managedByAccountId: adminId,
    });
    opsNoPermIdentity = {
      accountId: opsNo,
      sessionId: null as unknown as string,
      applicationType: "DASHBOARD",
      roles: ["OPERATIONS"],
      scopeType: "CITY",
      cityId: city,
      storeId: null,
    };

    const [m] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    merchantId = m!.id;
    await h.client`
      insert into merchant_profiles(account_id, store_id, city_id, display_name, status, created_by_account_id)
      values (${merchantId}, ${store}, ${city}, 'Merchant', 'ACTIVE', ${superId})`;
    merchantIdentity = {
      accountId: merchantId,
      sessionId: null as unknown as string,
      applicationType: "MERCHANT_APP",
      roles: [],
      scopeType: null,
      cityId: city,
      storeId: store,
    };
    merchantToken = "";

    const [m2] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    await h.client`
      insert into merchant_profiles(account_id, store_id, city_id, display_name, status, created_by_account_id)
      values (${m2!.id}, ${store2}, ${city}, 'Merchant 2', 'ACTIVE', ${superId})`;
    merchant2Identity = {
      accountId: m2!.id,
      sessionId: null as unknown as string,
      applicationType: "MERCHANT_APP",
      roles: [],
      scopeType: null,
      cityId: city,
      storeId: store2,
    };

    driverId = await createDriverAccount(
      h.client,
      "+9647701000001",
      "123456",
      "ACTIVE",
      city,
    );
    driver2Id = await createDriverAccount(
      h.client,
      "+9647701000002",
      "123456",
      "ACTIVE",
      city,
    );
    const issueDriverToken = async (id: string) => {
      const sess = await h.client.begin((tx) =>
        h.auth.sessions.create(
          tx,
          id,
          driverContext,
          "DRIVER_ACCESS_CODE",
          undefined,
          `drv-${id}`,
        ),
      );
      return (await h.auth.sessions.result(id, sess, driverContext)).access_token;
    };
    driverToken = await issueDriverToken(driverId);
    driver2Token = await issueDriverToken(driver2Id);
  });

  const freshDriver = async () => {
    const id = await createDriverAccount(
      h.client,
      `+964770${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const sess = await h.client.begin((tx) =>
      h.auth.sessions.create(
        tx,
        id,
        driverContext,
        "DRIVER_ACCESS_CODE",
        undefined,
        `drv-${id}`,
      ),
    );
    const token = (await h.auth.sessions.result(id, sess, driverContext))
      .access_token;
    return { id, token, identity: driverIdentity(id, city) };
  };

  afterAll(async () => {
    await h.close();
  });

  test("schema + OpenAPI contracts for C1", async () => {
    const tables = await h.client<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema='public' and table_name in (
        'order_events','order_custody_history','order_item_mutations','order_proofs'
      ) order by table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      "order_custody_history",
      "order_events",
      "order_item_mutations",
      "order_proofs",
    ]);
    const doc = (await (
      await h.app.handle(new Request("http://localhost/openapi/json"))
    ).json()) as { paths: Record<string, unknown> };
    expect(doc.paths["/api/v1/dashboard/orders/{orderId}/status"]).toBeUndefined();
    expect(doc.paths["/api/v1/mobile/merchant/orders/{orderId}/reject"]).toBeUndefined();
    expect(doc.paths["/api/v1/mobile/merchant/orders/{orderId}/cancel"]).toBeUndefined();
    const blob = JSON.stringify(doc);
    expect(blob).not.toContain("REJECTED_BY_STORE");
    expect(blob).toContain("ARRIVED_AT_STORE");
    expect(
      doc.paths["/api/v1/mobile/driver/orders/{orderId}/confirm-arrival-at-store"],
    ).toBeTruthy();
    expect(
      doc.paths["/api/v1/dashboard/orders/{orderId}/confirm-arrival-at-store"],
    ).toBeTruthy();
    expect(blob).toContain("PENDING_STORE_APPROVAL");
    expect(blob).toContain("PICKUP_PROOF");
    expect(blob).toContain("DELIVERY_PROOF");
    expect(blob).toContain("DASHBOARD_OVERRIDE");
    expect(
      doc.paths["/api/v1/dashboard/orders/{orderId}/confirm-pickup"],
    ).toBeTruthy();
  });

  test("create starts PENDING_STORE_APPROVAL with WITH_STORE and no offers", async () => {
    const order = await h.orders.create(customer, city, createBody());
    expect(order.status).toBe("PENDING_STORE_APPROVAL");
    expect(order.custodyStatus).toBe("WITH_STORE");
    expect(order.custodyDriverId).toBeNull();
    const rounds = await h.client<{ n: number }[]>`
      select count(*)::int n from order_offer_rounds where order_id = ${order.id}`;
    expect(rounds[0]!.n).toBe(0);
    const events = await h.client<{ event_type: string }[]>`
      select event_type::text from order_events where order_id = ${order.id}`;
    expect(events.map((e) => e.event_type)).toContain("ORDER_CREATED");
  });

  test("store approve opens exactly one offer round; retry is idempotent", async () => {
    const order = await h.orders.create(customer, city, createBody());
    const approvalKey = crypto.randomUUID();
    const approved = await h.orders.approve(merchantIdentity, order.id, {
      kind: "MERCHANT",
      storeId: store,
    }, approvalKey);
    expect(approved.status).toBe("SEARCHING_DRIVER");
    const rounds = await h.client<{ id: string; status: string }[]>`
      select id::text, status::text from order_offer_rounds where order_id = ${order.id}`;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.status).toBe("OPEN");
    const replay = await h.orders.approve(merchantIdentity, order.id, {
      kind: "MERCHANT",
      storeId: store,
    }, approvalKey);
    expect(replay.status).toBe("SEARCHING_DRIVER");
    const again = await h.client<{ n: number }[]>`
      select count(*)::int n from order_offer_rounds where order_id = ${order.id}`;
    expect(again[0]!.n).toBe(1);
    await expect(
      h.orders.approve(merchant2Identity, order.id, {
        kind: "MERCHANT",
        storeId: store2,
      }, crypto.randomUUID()),
    ).rejects.toMatchObject({ publicCode: "ORDER_NOT_FOUND", statusCode: 404 });
  });

  test("item mutations recalculate totals, keep delivery fee, require reason, lock after ready", async () => {
    const order = await h.orders.create(customer, city, createBody());
    const fee = order.deliveryFee as number;
    const added = await h.orders.addItem(
      merchantIdentity,
      order.id,
      { productId: product2, quantity: 1, reason: "طلب الزبون" },
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    expect(added.deliveryFee).toBe(fee);
    expect(added.productsSubtotal).toBe(1000 * 2 + 1500);
    const itemId = added.items.find((i: any) => i.productId === product)!.id;
    const qty = await h.orders.changeQuantity(
      merchantIdentity,
      order.id,
      itemId,
      { quantity: 3, reason: "تعديل كمية" },
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    expect(qty.productsSubtotal).toBe(1000 * 3 + 1500);
    expect(qty.deliveryFee).toBe(fee);
    await expect(
      h.orders.changeQuantity(
        merchantIdentity,
        order.id,
        itemId,
        { quantity: 1, reason: "" },
        { kind: "MERCHANT", storeId: store },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "VALIDATION_FAILED" });

    const beforeRemove = qty.productsSubtotal as number;
    const removedLine = qty.items.find((i: any) => i.productId === product2)!;
    const afterRemove = await h.orders.removeItem(
      merchantIdentity,
      order.id,
      removedLine.id,
      "غير متوفر",
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    expect(afterRemove.productsSubtotal).toBe(beforeRemove - 1500);
    const mutations = await h.client<{ mutation_type: string }[]>`
      select mutation_type from order_item_mutations where order_id = ${order.id}
      order by created_at`;
    expect(mutations.map((m) => m.mutation_type)).toEqual([
      "ADD",
      "QUANTITY_CHANGE",
      "REMOVE",
    ]);

    await h.orders.approve(merchantIdentity, order.id, {
      kind: "MERCHANT",
      storeId: store,
    }, crypto.randomUUID());
    const [round] = await h.client<{ id: string }[]>`
      select id::text from order_offer_rounds where order_id = ${order.id} and status='OPEN'`;
    const driver = await freshDriver();
    await h.offers.claim(driver.identity, round!.id, crypto.randomUUID());
    await h.orderLifecycle.markReady(merchantIdentity, order.id, {
      kind: "MERCHANT",
      storeId: store,
    }, crypto.randomUUID());
    await expect(
      h.orders.addItem(
        merchantIdentity,
        order.id,
        { productId: product2, quantity: 1, reason: "متأخر" },
        { kind: "MERCHANT", storeId: store },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "ORDER_ITEMS_LOCKED" });
  });

  test("happy path: claim → ready → pickup proof → arrive → deliver", async () => {
    const order = await h.orders.create(customer, city, createBody());
    await h.orders.approve(merchantIdentity, order.id, {
      kind: "MERCHANT",
      storeId: store,
    }, crypto.randomUUID());
    const [round] = await h.client<{ id: string }[]>`
      select id::text from order_offer_rounds where order_id = ${order.id} and status='OPEN'`;
    const driver = await freshDriver();
    const claim = await h.offers.claim(
      driver.identity,
      round!.id,
      crypto.randomUUID(),
    );
    expect(claim.orderId).toBe(order.id);
    const assigned = await h.client<
      {
        status: string;
        custody_status: string;
        assignment_status: string;
        driver_fee: number;
        assignment_id: string;
        assignment_source: string;
      }[]
    >`
      select o.status::text, o.custody_status::text, a.status::text as assignment_status,
             a.driver_fee, a.id::text as assignment_id, a.assignment_source::text
      from orders o
      join order_driver_assignments a on a.order_id = o.id
        and a.completed_at is null and a.cancelled_at is null
      where o.id = ${order.id}`;
    expect(assigned[0]).toMatchObject({
      status: "DRIVER_ASSIGNED",
      custody_status: "WITH_STORE",
      assignment_status: "ASSIGNED",
      assignment_source: "OFFER_CLAIM",
    });
    expect(assigned[0]!.driver_fee).toBeGreaterThan(0);
    const assignmentId = assigned[0]!.assignment_id;

    await expect(
      h.orderLifecycle.markReady(merchantIdentity, order.id, {
        kind: "MERCHANT",
        storeId: store,
      }, crypto.randomUUID()),
    ).resolves.toMatchObject({ status: "READY_FOR_PICKUP", custodyStatus: "WITH_STORE" });

    const arrivedAtStore = await h.app.handle(
      jsonRequest(
        `/api/v1/mobile/driver/orders/${order.id}/confirm-arrival-at-store`,
        {
          token: driver.token,
          body: {},
          headers: { "idempotency-key": crypto.randomUUID() },
        },
      ),
    );
    expect(arrivedAtStore.status).toBe(200);
    expect((await arrivedAtStore.json()).status).toBe("ARRIVED_AT_STORE");

    const missingProof = await h.app.handle(
      jsonRequest(`/api/v1/mobile/driver/orders/${order.id}/confirm-pickup`, {
        token: driver.token,
        body: {},
        headers: { "idempotency-key": crypto.randomUUID() },
      }),
    );
    expect(missingProof.status).toBe(422);
    expect((await missingProof.json()).error.code).toBe("PROOF_REQUIRED");

    const pickupFile = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    const wrongPurpose = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "DELIVERY_PROOF",
    );
    const wrongRes = await h.app.handle(
      jsonRequest(`/api/v1/mobile/driver/orders/${order.id}/confirm-pickup`, {
        token: driver.token,
        body: { fileId: wrongPurpose },
        headers: { "idempotency-key": crypto.randomUUID() },
      }),
    );
    expect(wrongRes.status).toBe(409);
    expect((await wrongRes.json()).error.code).toBe("PROOF_PURPOSE_MISMATCH");

    const pickupKey = crypto.randomUUID();
    const pickup = await h.app.handle(
      jsonRequest(`/api/v1/mobile/driver/orders/${order.id}/confirm-pickup`, {
        token: driver.token,
        body: { fileId: pickupFile },
        headers: { "idempotency-key": pickupKey },
      }),
    );
    expect(pickup.status).toBe(200);
    const picked = await pickup.json();
    expect(picked).toMatchObject({
      status: "PICKED_UP",
      custodyStatus: "WITH_DRIVER",
      custodyDriverId: driver.id,
    });
    const replayPickup = await h.app.handle(
      jsonRequest(`/api/v1/mobile/driver/orders/${order.id}/confirm-pickup`, {
        token: driver.token,
        body: { fileId: pickupFile },
        headers: { "idempotency-key": pickupKey },
      }),
    );
    expect(replayPickup.status).toBe(200);

    const other = await freshDriver();
    await expect(
      h.orderLifecycle.confirmArrival(other.identity, order.id, {}, {
        kind: "DRIVER",
      }, crypto.randomUUID()),
    ).rejects.toMatchObject({ publicCode: expect.stringMatching(/DRIVER_|ORDER_|PROOF_/) });

    const arrived = await h.orderLifecycle.confirmArrival(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    expect(arrived).toMatchObject({
      status: "ARRIVED_AT_CUSTOMER",
      custodyStatus: "WITH_DRIVER",
    });

    const missingDelivery = await h.app.handle(
      jsonRequest(`/api/v1/mobile/driver/orders/${order.id}/confirm-delivery`, {
        token: driver.token,
        body: { collectedAmount: order.total },
        headers: { "idempotency-key": crypto.randomUUID() },
      }),
    );
    expect(missingDelivery.status).toBe(422);
    expect((await missingDelivery.json()).error.code).toBe("VALIDATION_FAILED");

    const deliveryFile = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "DELIVERY_PROOF",
    );
    const deliveryKey = crypto.randomUUID();
    const deliveredRes = await h.app.handle(
      jsonRequest(`/api/v1/mobile/driver/orders/${order.id}/confirm-delivery`, {
        token: driver.token,
        body: { proofFileId: deliveryFile, collectedAmount: order.total },
        headers: { "idempotency-key": deliveryKey },
      }),
    );
    expect(deliveredRes.status).toBe(200);
    const delivered = await deliveredRes.json();
    expect(delivered).toMatchObject({
      status: "DELIVERED",
      custodyStatus: "WITH_CUSTOMER",
      custodyDriverId: null,
    });
    const assignment = await h.client<
      { status: string; completed_at: Date | null }[]
    >`select status::text, completed_at from order_driver_assignments where id = ${assignmentId}`;
    expect(assignment[0]!.status).toBe("COMPLETED");
    expect(assignment[0]!.completed_at).toBeTruthy();

    const events = await h.client<{ event_type: string; source: string }[]>`
      select event_type::text, source::text from order_events
      where order_id = ${order.id} order by created_at, id`;
    expect(events.map((e) => e.event_type)).toEqual([
      "ORDER_CREATED",
      "STORE_APPROVED",
      "DRIVER_ASSIGNED",
      "STORE_MARKED_READY",
      "DRIVER_ARRIVED_AT_STORE",
      "DRIVER_PICKED_UP",
      "DRIVER_ARRIVED_AT_CUSTOMER",
      "ORDER_DELIVERED",
    ]);

    const replayDeliver = await h.app.handle(
      jsonRequest(`/api/v1/mobile/driver/orders/${order.id}/confirm-delivery`, {
        token: driver.token,
        body: { proofFileId: deliveryFile, collectedAmount: order.total },
        headers: { "idempotency-key": deliveryKey },
      }),
    );
    expect(replayDeliver.status).toBe(200);
  });

  test("dashboard override natural transitions without proof; SUPER_ADMIN blocked", async () => {
    const order = await h.orders.create(customer, city, createBody());
    await h.orders.approve(
      adminIdentity, order.id, { kind: "DASHBOARD" }, crypto.randomUUID(),
    );
    const [round] = await h.client<{ id: string }[]>`
      select id::text from order_offer_rounds where order_id = ${order.id}`;
    const driver = await freshDriver();
    await h.offers.claim(driver.identity, round!.id, crypto.randomUUID());

    const ready = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/orders/${order.id}/mark-ready`, {
        token: adminToken,
        body: { reason: "المتجر أبلغ بالجاهزية", actedOnBehalfOf: "STORE" },
        headers: { "idempotency-key": crypto.randomUUID() },
      }),
    );
    expect(ready.status).toBe(200);

    const storeArrival = await h.app.handle(
      jsonRequest(
        `/api/v1/dashboard/orders/${order.id}/confirm-arrival-at-store`,
        {
          token: adminToken,
          body: { reason: "السائق وصل للمتجر" },
          headers: { "idempotency-key": crypto.randomUUID() },
        },
      ),
    );
    expect(storeArrival.status).toBe(200);

    const pickup = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/orders/${order.id}/confirm-pickup`, {
        token: adminToken,
        body: { reason: "استلام إداري", actedOnBehalfOf: "DRIVER" },
        headers: { "idempotency-key": crypto.randomUUID() },
      }),
    );
    expect(pickup.status).toBe(200);
    expect((await pickup.json()).custodyStatus).toBe("WITH_DRIVER");

    const arrive = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/orders/${order.id}/confirm-arrival`, {
        token: adminToken,
        body: { reason: "وصول إداري", actedOnBehalfOf: "DRIVER" },
        headers: { "idempotency-key": crypto.randomUUID() },
      }),
    );
    expect(arrive.status).toBe(200);

    const deliver = await h.app.handle(
      jsonRequest(`/api/v1/dashboard/orders/${order.id}/confirm-delivery`, {
        token: adminToken,
        body: { collectedAmount: order.total, reason: "تسليم إداري", actedOnBehalfOf: "DRIVER" },
        headers: { "idempotency-key": crypto.randomUUID() },
      }),
    );
    expect(deliver.status).toBe(200);

    const overrideEvents = await h.client<{ source: string; acted_on_behalf_of: string }[]>`
      select source::text, acted_on_behalf_of from order_events
      where order_id = ${order.id} and source = 'DASHBOARD_OVERRIDE'`;
    expect(overrideEvents.length).toBeGreaterThanOrEqual(4);
    expect(overrideEvents.every((e) => !!e.acted_on_behalf_of)).toBe(true);

    await expect(
      h.orderLifecycle.markReady(superIdentity, order.id, {
        kind: "DASHBOARD",
        reason: "ممنوع",
        actedOnBehalfOf: "STORE",
      }, crypto.randomUUID()),
    ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });

    await expect(
      h.orderLifecycle.confirmPickup(
        opsNoPermIdentity,
        order.id,
        { reason: "x" },
        { kind: "DASHBOARD", reason: "بلا صلاحية", actedOnBehalfOf: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });
  });

  test("cannot skip arrive before pickup; mark ready requires assignment", async () => {
    const order = await h.orders.create(customer, city, createBody());
    await h.orders.approve(merchantIdentity, order.id, {
      kind: "MERCHANT",
      storeId: store,
    }, crypto.randomUUID());
    await expect(
      h.orderLifecycle.markReady(merchantIdentity, order.id, {
        kind: "MERCHANT",
        storeId: store,
      }, crypto.randomUUID()),
    ).rejects.toMatchObject({ publicCode: "DRIVER_ASSIGNMENT_REQUIRED" });

    const [round] = await h.client<{ id: string }[]>`
      select id::text from order_offer_rounds where order_id = ${order.id}`;
    const driver = await freshDriver();
    await h.offers.claim(driver.identity, round!.id, crypto.randomUUID());
    await h.orderLifecycle.markReady(merchantIdentity, order.id, {
      kind: "MERCHANT",
      storeId: store,
    }, crypto.randomUUID());
    await expect(
      h.orderLifecycle.confirmArrival(driver.identity, order.id, {}, {
        kind: "DRIVER",
      }, crypto.randomUUID()),
    ).rejects.toMatchObject({ publicCode: "ORDER_INVALID_TRANSITION" });
  });

  test("concurrent pickups converge once", async () => {
    const order = await h.orders.create(customer, city, createBody());
    await h.orders.approve(merchantIdentity, order.id, {
      kind: "MERCHANT",
      storeId: store,
    }, crypto.randomUUID());
    const [round] = await h.client<{ id: string }[]>`
      select id::text from order_offer_rounds where order_id = ${order.id}`;
    const driver = await freshDriver();
    await h.offers.claim(driver.identity, round!.id, crypto.randomUUID());
    await h.orderLifecycle.markReady(merchantIdentity, order.id, {
      kind: "MERCHANT",
      storeId: store,
    }, crypto.randomUUID());
    await h.orderLifecycle.confirmArrivalAtStore(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const results = await Promise.allSettled([
      h.orderLifecycle.confirmPickup(
        adminIdentity,
        order.id,
        {},
        { kind: "DASHBOARD", reason: "إداري 1", actedOnBehalfOf: "DRIVER" },
        crypto.randomUUID(),
      ),
      h.orderLifecycle.confirmPickup(
        adminIdentity,
        order.id,
        {},
        { kind: "DASHBOARD", reason: "إداري 2", actedOnBehalfOf: "DRIVER" },
        crypto.randomUUID(),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const row = await h.client<{ status: string; custody_status: string }[]>`
      select status::text, custody_status::text from orders where id = ${order.id}`;
    expect(row[0]).toMatchObject({
      status: "PICKED_UP",
      custody_status: "WITH_DRIVER",
    });
    const picks = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'DRIVER_PICKED_UP'`;
    expect(picks[0]!.n).toBe(1);
  });

  test("cross-city dashboard override returns 404", async () => {
    const order = await h.orders.create(customer, city, createBody());
    const otherAdmin = await createStaffAccount(h.auth, h.client, {
      email: `lifecycle-other-${crypto.randomUUID()}@example.com`,
      password: "fixed dashboard password",
      roles: ["ADMIN"],
      cityId: city2,
    });
    const otherIdentity: AuthIdentity = {
      accountId: otherAdmin,
      sessionId: null as unknown as string,
      applicationType: "DASHBOARD",
      roles: ["ADMIN"],
      scopeType: "CITY",
      cityId: city2,
      storeId: null,
    };
    await expect(
      h.orders.approve(
        otherIdentity, order.id, { kind: "DASHBOARD" }, crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "ORDER_NOT_FOUND", statusCode: 404 });
  });
});
