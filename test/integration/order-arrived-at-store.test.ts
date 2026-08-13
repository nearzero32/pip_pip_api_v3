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

describe("driver arrived at store", () => {
  let h: IntegrationHarness;
  let city = "";
  let city2 = "";
  let store = "";
  let product = "";
  let customer = "";
  let addressId = "";
  let merchantIdentity!: AuthIdentity;
  let adminIdentity!: AuthIdentity;
  let adminToken = "";
  let superIdentity!: AuthIdentity;
  let superId = "";

  const driverIdentity = (id: string, cityId: string): AuthIdentity => ({
    accountId: id,
    sessionId: null as unknown as string,
    applicationType: "DRIVER_APP",
    roles: [],
    scopeType: null,
    cityId,
    storeId: null,
  });

  const createBody = (overrides: Record<string, unknown> = {}) => ({
    storeId: store,
    addressId,
    paymentMethod: "CASH" as const,
    items: [{ productId: product, quantity: 1 }],
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  });

  const freshDriver = async () => {
    const id = await createDriverAccount(
      h.client,
      `+964774${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
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
        `arrival-${id}`,
      ),
    );
    const token = (await h.auth.sessions.result(id, sess, driverContext))
      .access_token;
    return { id, token, identity: driverIdentity(id, city) };
  };

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

  const putOpsProof = async (
    driverTok: string,
    orderId: string,
    assignmentId: string,
    purpose: "HANDOFF_PROOF" | "RETURN_PROOF",
    extra: { handoffId?: string; returnWorkflowId?: string } = {},
  ) => {
    const intentRes = await h.app.handle(
      jsonRequest(
        `/api/v1/mobile/driver/orders/${orderId}/proofs/ops-upload-intent`,
        {
          token: driverTok,
          body: {
            assignmentId,
            purpose,
            contentType: "image/png",
            fileName: `${purpose.toLowerCase()}.png`,
            sizeBytes: PNG.length,
            ...extra,
          },
        },
      ),
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

  const approveAndClaim = async (opts: { markReady?: boolean } = {}) => {
    const markReady = opts.markReady !== false;
    const order = await h.orders.create(customer, city, createBody());
    await h.orders.approve(
      merchantIdentity,
      order.id,
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    const [round] = await h.client<{ id: string }[]>`
      select id::text from order_offer_rounds where order_id = ${order.id}`;
    const driver = await freshDriver();
    await h.offers.claim(driver.identity, round!.id, crypto.randomUUID());
    if (markReady) {
      await h.orderLifecycle.markReady(
        merchantIdentity,
        order.id,
        { kind: "MERCHANT", storeId: store },
        crypto.randomUUID(),
      );
    }
    const [assignment] = await h.client<{ id: string }[]>`
      select id::text from order_driver_assignments
      where order_id = ${order.id} and completed_at is null and cancelled_at is null`;
    return { order, driver, assignmentId: assignment!.id };
  };

  const snapshot = async (orderId: string) => {
    const [row] = await h.client<
      {
        status: string;
        custody_status: string;
        custody_driver_id: string | null;
        store_ready_marked_at: Date | null;
      }[]
    >`select status::text, custody_status::text, custody_driver_id::text,
             store_ready_marked_at
      from orders where id = ${orderId}`;
    return row!;
  };

  const assignmentOf = async (assignmentId: string) => {
    const [row] = await h.client<
      {
        status: string;
        arrived_at_store_at: Date | null;
        picked_up_at: Date | null;
      }[]
    >`select status::text, arrived_at_store_at, picked_up_at
      from order_driver_assignments where id = ${assignmentId}`;
    return row!;
  };

  beforeAll(async () => {
    h = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_arrived_store",
    });
    city = await createActiveCity(h.client, "Arrival City");
    city2 = await createActiveCity(h.client, "Arrival City 2");
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
    const [logo] = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values (
        ${city}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l.png',
        'image/png', 1, 'image/png', 1, ${superId}, now(), now(), now()
      ) returning id`;
    const [cat] = await h.client<{ id: string }[]>`
      insert into main_categories(city_id, name, image_asset_id, status, created_by_account_id)
      values (${city}, 'مطاعم', ${media!.id}, 'ACTIVE', ${superId}) returning id`;
    const [s] = await h.client<{ id: string }[]>`
      insert into stores(
        city_id, main_category_id, name, phone, address, location, logo_asset_id,
        status, order_acceptance_status, created_by_account_id
      ) values (
        ${city}, ${cat!.id}, 'Arrival Store', '+9647005555577', 'Address',
        ST_SetSRID(ST_MakePoint(44.4, 33.3), 4326), ${logo!.id},
        'ACTIVE', 'ACCEPTING', ${superId}
      ) returning id`;
    store = s!.id;
    const [z] = await h.client<{ id: string }[]>`
      insert into zones(city_id, name, boundary, status)
      values (
        ${city}, 'Delivery',
        ST_GeomFromText('POLYGON((44 33,45 33,45 34,44 34,44 33))', 4326),
        'ACTIVE'
      ) returning id`;
    await h.client`insert into store_zones(store_id, zone_id, city_id) values (${store}, ${z!.id}, ${city})`;
    const [p] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${store}, ${city}, 'منتج', 1000, true, 'ACTIVE', ${superId}) returning id`;
    product = p!.id;

    await h.deliveryPricing.create(superIdentity, city, pricingInput);
    const versions = await h.deliveryPricing.list(superIdentity, city);
    await h.deliveryPricing.activate(superIdentity, city, versions[0]!.id);
    await h.cityDriverPricing.put(
      superIdentity,
      city,
      {
        pricingBase: 3000,
        roundingUnit: 250,
        pricingStages: [{ afterSeconds: 0, increasePercentage: 0 }],
      },
      "arrival-driver-pricing",
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
      email: "arrival-admin@example.com",
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
        email: "arrival-admin@example.com",
        password: "fixed dashboard password",
        deviceName: "arrival-admin",
        ip: "arrival-admin",
        requestId: "arrival-admin",
      })
    ).access_token;

    const [m] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    await h.client`
      insert into merchant_profiles(account_id, store_id, city_id, display_name, status, created_by_account_id)
      values (${m!.id}, ${store}, ${city}, 'Arrival Merchant', 'ACTIVE', ${superId})`;
    merchantIdentity = {
      accountId: m!.id,
      sessionId: null as unknown as string,
      applicationType: "MERCHANT_APP",
      roles: [],
      scopeType: null,
      cityId: city,
      storeId: store,
    };
  });

  afterAll(async () => {
    await h.close();
  });

  test("assigned → arrival sets ARRIVED_AT_STORE without photo or GPS and keeps custody WITH_STORE", async () => {
    const { order, driver, assignmentId } = await approveAndClaim({
      markReady: false,
    });
    const res = await h.app.handle(
      jsonRequest(
        `/api/v1/mobile/driver/orders/${order.id}/confirm-arrival-at-store`,
        {
          token: driver.token,
          body: {},
          headers: { "idempotency-key": crypto.randomUUID() },
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ARRIVED_AT_STORE");
    expect(body.custodyStatus).toBe("WITH_STORE");
    expect(body.custodyDriverId).toBeNull();
    expect(body.arrivedAtStoreAt).toBeTruthy();
    expect(body.canConfirmArrivalAtStore).toBe(false);
    expect(body.canConfirmPickup).toBe(false);
    const row = await snapshot(order.id);
    expect(row).toMatchObject({
      status: "ARRIVED_AT_STORE",
      custody_status: "WITH_STORE",
      custody_driver_id: null,
    });
    const assignment = await assignmentOf(assignmentId);
    expect(assignment.status).toBe("ARRIVED_AT_STORE");
    expect(assignment.arrived_at_store_at).toBeTruthy();
    expect(assignment.picked_up_at).toBeNull();
    const events = await h.client<{ event_type: string; source: string }[]>`
      select event_type::text, source::text from order_events
      where order_id = ${order.id} and event_type = 'DRIVER_ARRIVED_AT_STORE'`;
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe("DRIVER_APP");
  });

  test("ready first then arrival then pickup succeeds", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    const arrived = await h.orderLifecycle.confirmArrivalAtStore(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    expect(arrived.status).toBe("ARRIVED_AT_STORE");
    expect(arrived.storeReadyMarkedAt).toBeTruthy();
    expect(arrived.canConfirmPickup).toBe(true);
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    const picked = await h.orderLifecycle.confirmPickup(
      driver.identity,
      order.id,
      { fileId },
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    expect(picked.status).toBe("PICKED_UP");
    expect(picked.custodyStatus).toBe("WITH_DRIVER");
  });

  test("arrival first then store ready then pickup succeeds; mark-ready keeps ARRIVED_AT_STORE", async () => {
    const { order, driver, assignmentId } = await approveAndClaim({
      markReady: false,
    });
    await h.orderLifecycle.confirmArrivalAtStore(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const ready = await h.orderLifecycle.markReady(
      merchantIdentity,
      order.id,
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    expect(ready.status).toBe("ARRIVED_AT_STORE");
    expect(ready.storeReadyMarkedAt).toBeTruthy();
    expect(ready.custodyStatus).toBe("WITH_STORE");
    const assignment = await assignmentOf(assignmentId);
    expect(assignment.arrived_at_store_at).toBeTruthy();
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    const picked = await h.orderLifecycle.confirmPickup(
      driver.identity,
      order.id,
      { fileId },
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    expect(picked.status).toBe("PICKED_UP");
  });

  test("arrival without ready blocks pickup", async () => {
    const { order, driver, assignmentId } = await approveAndClaim({
      markReady: false,
    });
    await h.orderLifecycle.confirmArrivalAtStore(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    await expect(
      h.orderLifecycle.confirmPickup(
        driver.identity,
        order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "ORDER_NOT_READY_FOR_PICKUP" });
  });

  test("ready without arrival blocks pickup", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    await expect(
      h.orderLifecycle.confirmPickup(
        driver.identity,
        order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      publicCode: "DRIVER_HAS_NOT_ARRIVED_AT_STORE",
    });
  });

  test("arrival + ready without proof blocks driver pickup", async () => {
    const { order, driver } = await approveAndClaim();
    await h.orderLifecycle.confirmArrivalAtStore(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    await expect(
      h.orderLifecycle.confirmPickup(
        driver.identity,
        order.id,
        {},
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "PROOF_REQUIRED" });
  });

  test("dashboard records arrival with reason and no photo; pickup cannot invent ready or arrival", async () => {
    const { order, driver } = await approveAndClaim({ markReady: false });
    await expect(
      h.orderLifecycle.confirmPickup(
        adminIdentity,
        order.id,
        { reason: "تخطي" },
        { kind: "DASHBOARD", reason: "تخطي", actedOnBehalfOf: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "ORDER_NOT_READY_FOR_PICKUP" });

    const missingReason = await h.app.handle(
      jsonRequest(
        `/api/v1/dashboard/orders/${order.id}/confirm-arrival-at-store`,
        {
          token: adminToken,
          body: {},
          headers: { "idempotency-key": crypto.randomUUID() },
        },
      ),
    );
    expect(missingReason.status).toBe(422);

    const arrival = await h.app.handle(
      jsonRequest(
        `/api/v1/dashboard/orders/${order.id}/confirm-arrival-at-store`,
        {
          token: adminToken,
          body: { reason: "السائق وصل" },
          headers: { "idempotency-key": crypto.randomUUID() },
        },
      ),
    );
    expect(arrival.status).toBe(200);
    const arrived = await arrival.json();
    expect(arrived.status).toBe("ARRIVED_AT_STORE");
    expect(arrived.custodyStatus).toBe("WITH_STORE");
    const events = await h.client<
      { source: string; acted_on_behalf_of: string; reason: string }[]
    >`
      select source::text, acted_on_behalf_of, reason from order_events
      where order_id = ${order.id} and event_type = 'DRIVER_ARRIVED_AT_STORE'`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "DASHBOARD_OVERRIDE",
      acted_on_behalf_of: "DRIVER",
      reason: "السائق وصل",
    });

    await expect(
      h.orderLifecycle.confirmPickup(
        adminIdentity,
        order.id,
        { reason: "بدون جاهزية" },
        {
          kind: "DASHBOARD",
          reason: "بدون جاهزية",
          actedOnBehalfOf: "DRIVER",
        },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "ORDER_NOT_READY_FOR_PICKUP" });

    await h.orderLifecycle.markReady(
      merchantIdentity,
      order.id,
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    const picked = await h.orderLifecycle.confirmPickup(
      adminIdentity,
      order.id,
      { reason: "استلام إداري" },
      {
        kind: "DASHBOARD",
        reason: "استلام إداري",
        actedOnBehalfOf: "DRIVER",
      },
      crypto.randomUUID(),
    );
    expect(picked.status).toBe("PICKED_UP");
    expect(driver.id).toBeTruthy();
  });

  test("other driver and closed assignment are rejected; cross-city is 404; SUPER_ADMIN is forbidden", async () => {
    const { order, driver } = await approveAndClaim();
    const other = await freshDriver();
    await expect(
      h.orderLifecycle.confirmArrivalAtStore(
        other.identity,
        order.id,
        {},
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "DRIVER_ASSIGNMENT_REQUIRED" });

    await h.orderOps.removeDriverBeforePickup(adminIdentity, order.id, {
      reason: "إزالة",
      nextAction: "REOFFER",
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      h.orderLifecycle.confirmArrivalAtStore(
        driver.identity,
        order.id,
        {},
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      publicCode: expect.stringMatching(
        /DRIVER_ASSIGNMENT_REQUIRED|ORDER_INVALID_TRANSITION/,
      ),
    });

    const fresh = await approveAndClaim();
    const otherAdmin = await createStaffAccount(h.auth, h.client, {
      email: `arrival-other-${crypto.randomUUID()}@example.com`,
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
      h.orderLifecycle.confirmArrivalAtStore(
        otherIdentity,
        fresh.order.id,
        { reason: "مدينة أخرى" },
        {
          kind: "DASHBOARD",
          reason: "مدينة أخرى",
          actedOnBehalfOf: "DRIVER",
        },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "ORDER_NOT_FOUND", statusCode: 404 });

    await expect(
      h.orderLifecycle.confirmArrivalAtStore(
        superIdentity,
        fresh.order.id,
        { reason: "ممنوع" },
        { kind: "DASHBOARD", reason: "ممنوع", actedOnBehalfOf: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });
  });

  test("replay does not repeat timestamp or event; reused key with different payload is rejected", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    const key = crypto.randomUUID();
    const first = await h.orderLifecycle.confirmArrivalAtStore(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      key,
    );
    const second = await h.orderLifecycle.confirmArrivalAtStore(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      key,
    );
    expect(second.arrivedAtStoreAt).toBe(first.arrivedAtStoreAt);
    const assignment = await assignmentOf(assignmentId);
    expect(assignment.arrived_at_store_at).toBeTruthy();
    const events = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'DRIVER_ARRIVED_AT_STORE'`;
    expect(events[0]!.n).toBe(1);

    const dashOrder = await approveAndClaim();
    const dashKey = crypto.randomUUID();
    await h.orderLifecycle.confirmArrivalAtStore(
      adminIdentity,
      dashOrder.order.id,
      { reason: "سبب أول" },
      {
        kind: "DASHBOARD",
        reason: "سبب أول",
        actedOnBehalfOf: "DRIVER",
      },
      dashKey,
    );
    await expect(
      h.orderLifecycle.confirmArrivalAtStore(
        adminIdentity,
        dashOrder.order.id,
        { reason: "سبب مختلف" },
        {
          kind: "DASHBOARD",
          reason: "سبب مختلف",
          actedOnBehalfOf: "DRIVER",
        },
        dashKey,
      ),
    ).rejects.toMatchObject({ publicCode: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("arrival × mark-ready records both facts without lost update", async () => {
    const { order, driver } = await approveAndClaim({ markReady: false });
    const results = await Promise.allSettled([
      h.orderLifecycle.confirmArrivalAtStore(
        driver.identity,
        order.id,
        {},
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
      h.orderLifecycle.markReady(
        merchantIdentity,
        order.id,
        { kind: "MERCHANT", storeId: store },
        crypto.randomUUID(),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const row = await snapshot(order.id);
    expect(row.status).toBe("ARRIVED_AT_STORE");
    expect(row.custody_status).toBe("WITH_STORE");
    expect(row.store_ready_marked_at).toBeTruthy();
    const arrivals = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'DRIVER_ARRIVED_AT_STORE'`;
    const ready = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'STORE_MARKED_READY'`;
    expect(arrivals[0]!.n).toBe(1);
    expect(ready[0]!.n).toBe(1);
  });

  test("driver × dashboard arrival produces one event and one timestamp", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    const results = await Promise.allSettled([
      h.orderLifecycle.confirmArrivalAtStore(
        driver.identity,
        order.id,
        {},
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
      h.orderLifecycle.confirmArrivalAtStore(
        adminIdentity,
        order.id,
        { reason: "وصول إداري" },
        {
          kind: "DASHBOARD",
          reason: "وصول إداري",
          actedOnBehalfOf: "DRIVER",
        },
        crypto.randomUUID(),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    const assignment = await assignmentOf(assignmentId);
    expect(assignment.status).toBe("ARRIVED_AT_STORE");
    const events = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'DRIVER_ARRIVED_AT_STORE'`;
    expect(events[0]!.n).toBe(1);
  });

  test("replacement does not inherit arrival; substitute must arrive before pickup", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await h.orderLifecycle.confirmArrivalAtStore(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const replacement = await freshDriver();
    await h.orderOps.removeDriverBeforePickup(adminIdentity, order.id, {
      reason: "تبديل قبل الاستلام",
      nextAction: "ASSIGN_DRIVER",
      driverId: replacement.id,
      idempotencyKey: crypto.randomUUID(),
    });
    const old = await assignmentOf(assignmentId);
    expect(old.arrived_at_store_at).toBeTruthy();
    const [next] = await h.client<
      { id: string; arrived_at_store_at: Date | null; status: string }[]
    >`select id::text, arrived_at_store_at, status::text from order_driver_assignments
      where order_id = ${order.id} and completed_at is null and cancelled_at is null`;
    expect(next!.id).not.toBe(assignmentId);
    expect(next!.arrived_at_store_at).toBeNull();
    expect(next!.status).toBe("ASSIGNED");
    const fileId = await putReadyProof(
      replacement.token,
      order.id,
      next!.id,
      "PICKUP_PROOF",
    );
    await expect(
      h.orderLifecycle.confirmPickup(
        replacement.identity,
        order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      publicCode: "DRIVER_HAS_NOT_ARRIVED_AT_STORE",
    });
    await h.orderLifecycle.confirmArrivalAtStore(
      replacement.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const picked = await h.orderLifecycle.confirmPickup(
      replacement.identity,
      order.id,
      { fileId },
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    expect(picked.status).toBe("PICKED_UP");
  });

  test("arrival × replacement does not copy arrival onto the substitute", async () => {
    const { order, driver, assignmentId } = await approveAndClaim({
      markReady: false,
    });
    const replacement = await freshDriver();
    const results = await Promise.allSettled([
      h.orderLifecycle.confirmArrivalAtStore(
        driver.identity,
        order.id,
        {},
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
      h.orderOps.removeDriverBeforePickup(adminIdentity, order.id, {
        reason: "سباق استبدال",
        nextAction: "ASSIGN_DRIVER",
        driverId: replacement.id,
        idempotencyKey: crypto.randomUUID(),
      }),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const [next] = await h.client<
      { id: string; arrived_at_store_at: Date | null }[]
    >`select id::text, arrived_at_store_at from order_driver_assignments
      where order_id = ${order.id} and completed_at is null and cancelled_at is null`;
    if (next) {
      expect(next.id).not.toBe(assignmentId);
      expect(next.arrived_at_store_at).toBeNull();
    }
  });

  test("handoff after pickup does not require store arrival", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await h.orderLifecycle.confirmArrivalAtStore(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    await h.orderLifecycle.confirmPickup(
      driver.identity,
      order.id,
      { fileId },
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const replacement = await freshDriver();
    const started = await h.orderOps.startHandoffAssign(
      adminIdentity,
      order.id,
      {
        driverId: replacement.id,
        reason: "تسليم عهدة",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    const [toAssignment] = await h.client<{ id: string }[]>`
      select id::text from order_driver_assignments
      where order_id = ${order.id} and driver_id = ${replacement.id}
        and status = 'HANDOFF_PENDING'`;
    const handoffFile = await putOpsProof(
      replacement.token,
      order.id,
      toAssignment!.id,
      "HANDOFF_PROOF",
      { handoffId: started.handoff!.id },
    );
    const completed = await h.orderOps.completeHandoff(
      replacement.identity,
      order.id,
      started.handoff!.id,
      { fileId: handoffFile, idempotencyKey: crypto.randomUUID() },
      { kind: "DRIVER" },
    );
    expect(completed.custodyDriverId).toBe(replacement.id);
    expect(completed.status).not.toBe("ARRIVED_AT_STORE");
    const [to] = await h.client<{ arrived_at_store_at: Date | null; status: string }[]>`
      select arrived_at_store_at, status::text from order_driver_assignments
      where id = ${toAssignment!.id}`;
    expect(to!.status).toBe("PICKED_UP");
    expect(to!.arrived_at_store_at).toBeNull();
  });

  test("return then new assignment requires a fresh store arrival", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await h.orderLifecycle.confirmArrivalAtStore(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    await h.orderLifecycle.confirmPickup(
      driver.identity,
      order.id,
      { fileId },
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    await h.orderOps.startReturnToStore(adminIdentity, order.id, {
      reason: "إرجاع مستقل",
      idempotencyKey: crypto.randomUUID(),
    });
    const [workflow] = await h.client<{ id: string }[]>`
      select id::text from order_return_workflows where order_id = ${order.id}`;
    const returnFile = await putOpsProof(
      driver.token,
      order.id,
      assignmentId,
      "RETURN_PROOF",
      { returnWorkflowId: workflow!.id },
    );
    await h.orderOps.confirmDriverReturn(
      driver.identity,
      order.id,
      { fileId: returnFile, idempotencyKey: crypto.randomUUID() },
      { kind: "DRIVER" },
    );
    await h.orderOps.confirmStoreReturn(
      merchantIdentity,
      order.id,
      { idempotencyKey: crypto.randomUUID() },
      { kind: "MERCHANT", storeId: store },
    );
    const nextDriver = await freshDriver();
    await h.orderOps.reopenOrder(adminIdentity, order.id, {
      reason: "إعادة فتح",
      nextAction: "ASSIGN_DRIVER",
      driverId: nextDriver.id,
      idempotencyKey: crypto.randomUUID(),
    });
    const [next] = await h.client<
      { id: string; arrived_at_store_at: Date | null }[]
    >`select id::text, arrived_at_store_at from order_driver_assignments
      where order_id = ${order.id} and completed_at is null and cancelled_at is null`;
    expect(next!.arrived_at_store_at).toBeNull();
    const pickupFile = await putReadyProof(
      nextDriver.token,
      order.id,
      next!.id,
      "PICKUP_PROOF",
    );
    await expect(
      h.orderLifecycle.confirmPickup(
        nextDriver.identity,
        order.id,
        { fileId: pickupFile },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      publicCode: "DRIVER_HAS_NOT_ARRIVED_AT_STORE",
    });
    await h.orderLifecycle.confirmArrivalAtStore(
      nextDriver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const picked = await h.orderLifecycle.confirmPickup(
      nextDriver.identity,
      order.id,
      { fileId: pickupFile },
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    expect(picked.status).toBe("PICKED_UP");
  });

  test("arrival × cancel does not record arrival after cancellation", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    const results = await Promise.allSettled([
      h.orderLifecycle.confirmArrivalAtStore(
        driver.identity,
        order.id,
        {},
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
      h.orders.cancelByDashboard(adminIdentity, order.id, "إلغاء متزامن"),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const row = await snapshot(order.id);
    expect(row.status).toBe("CANCELLED");
    const events = await h.client<{ created_at: Date }[]>`
      select created_at from order_events
      where order_id = ${order.id} and event_type = 'DRIVER_ARRIVED_AT_STORE'`;
    if (events.length > 0) {
      const [cancelled] = await h.client<{ cancelled_at: Date }[]>`
        select cancelled_at from orders where id = ${order.id}`;
      expect(new Date(events[0]!.created_at).getTime()).toBeLessThanOrEqual(
        new Date(cancelled!.cancelled_at).getTime(),
      );
    }
    await expect(
      h.orderLifecycle.confirmArrivalAtStore(
        driver.identity,
        order.id,
        {},
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      publicCode: expect.stringMatching(
        /ORDER_ALREADY_CANCELLED|DRIVER_ASSIGNMENT_REQUIRED|ORDER_INVALID_TRANSITION/,
      ),
    });
    const assignment = await assignmentOf(assignmentId);
    expect(assignment.picked_up_at).toBeNull();
  });

  test("arrival × pickup does not partially transfer custody", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    const results = await Promise.allSettled([
      h.orderLifecycle.confirmArrivalAtStore(
        driver.identity,
        order.id,
        {},
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
      h.orderLifecycle.confirmPickup(
        driver.identity,
        order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ]);
    const row = await snapshot(order.id);
    expect(row.custody_status).toBe(
      results.some(
        (r) => r.status === "fulfilled" && r.value?.status === "PICKED_UP",
      )
        ? "WITH_DRIVER"
        : "WITH_STORE",
    );
    if (row.status !== "PICKED_UP") {
      expect(row.custody_status).toBe("WITH_STORE");
      await h.orderLifecycle.confirmArrivalAtStore(
        driver.identity,
        order.id,
        {},
        { kind: "DRIVER" },
        crypto.randomUUID(),
      );
      const picked = await h.orderLifecycle.confirmPickup(
        driver.identity,
        order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      );
      expect(picked.status).toBe("PICKED_UP");
      expect(picked.custodyStatus).toBe("WITH_DRIVER");
    }
  });

  test("OpenAPI documents arrival paths without requiring photo or GPS", async () => {
    const doc = (await (
      await h.app.handle(new Request("http://localhost/openapi/json"))
    ).json()) as { paths: Record<string, any> };
    const driverPath =
      doc.paths["/api/v1/mobile/driver/orders/{orderId}/confirm-arrival-at-store"];
    const dashPath =
      doc.paths["/api/v1/dashboard/orders/{orderId}/confirm-arrival-at-store"];
    expect(driverPath?.post).toBeTruthy();
    expect(dashPath?.post).toBeTruthy();
    const schema =
      driverPath.post.requestBody?.content?.["application/json"]?.schema;
    expect(schema?.properties ?? {}).toEqual({});
    expect(JSON.stringify(schema)).not.toContain("fileId");
    expect(JSON.stringify(schema)).not.toContain("latitude");
    expect(JSON.stringify(schema)).not.toContain("longitude");
    expect(JSON.stringify(dashPath)).toContain("reason");
    expect(JSON.stringify(doc)).toContain("ARRIVED_AT_STORE");
    expect(JSON.stringify(doc)).toContain("DRIVER_HAS_NOT_ARRIVED_AT_STORE");
  });
});
