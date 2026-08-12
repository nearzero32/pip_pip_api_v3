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

describe("M4-C1 gap closure: cancel, proofs, custody constraints, idempotency", () => {
  let h: IntegrationHarness;
  let city = "";
  let store = "";
  let product = "";
  let product2 = "";
  let customer = "";
  let addressId = "";
  let merchantIdentity!: AuthIdentity;
  let adminIdentity!: AuthIdentity;
  let adminToken = "";
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
      `+964771${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
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
        `gap-${id}`,
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

  const approveAndClaimReady = async () => {
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
    await h.orderLifecycle.markReady(
      merchantIdentity,
      order.id,
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    const [assignment] = await h.client<{ id: string }[]>`
      select id::text from order_driver_assignments
      where order_id = ${order.id} and completed_at is null and cancelled_at is null`;
    return { order, driver, assignmentId: assignment!.id };
  };

  beforeAll(async () => {
    h = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_m4c1_gaps",
    });
    city = await createActiveCity(h.client, "Gap City");
    const [actor] = await h.client<{ id: string }[]>`
      insert into accounts default values returning id`;
    superId = actor!.id;
    const superIdentity: AuthIdentity = {
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
        ${city}, ${cat!.id}, 'Gap Store', '+9647003333333', 'Address',
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
    const [p2] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${store}, ${city}, 'منتج 2', 1500, true, 'ACTIVE', ${superId}) returning id`;
    product2 = p2!.id;

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
      "gap-driver-pricing",
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
      email: "gaps-admin@example.com",
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
        email: "gaps-admin@example.com",
        password: "fixed dashboard password",
        deviceName: "gaps-admin",
        ip: "gaps-admin",
        requestId: "gaps-admin",
      })
    ).access_token;

    const [m] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    await h.client`
      insert into merchant_profiles(account_id, store_id, city_id, display_name, status, created_by_account_id)
      values (${m!.id}, ${store}, ${city}, 'Gap Merchant', 'ACTIVE', ${superId})`;
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

  test("concurrent driver and dashboard pickup produce one transition and one event", async () => {
    const { order, driver, assignmentId } = await approveAndClaimReady();
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    const results = await Promise.allSettled([
      h.orderLifecycle.confirmPickup(
        driver.identity,
        order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
      h.orderLifecycle.confirmPickup(
        adminIdentity,
        order.id,
        {},
        { kind: "DASHBOARD", reason: "إداري متزامن", actedOnBehalfOf: "DRIVER" },
        crypto.randomUUID(),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const row = await h.client<{ status: string; custody_status: string }[]>`
      select status::text, custody_status::text from orders where id = ${order.id}`;
    expect(row[0]).toMatchObject({
      status: "PICKED_UP",
      custody_status: "WITH_DRIVER",
    });
    const events = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'DRIVER_PICKED_UP'`;
    expect(events[0]!.n).toBe(1);
  });

  test("concurrent driver and dashboard delivery complete once only", async () => {
    const { order, driver, assignmentId } = await approveAndClaimReady();
    const pickupFile = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    await h.orderLifecycle.confirmPickup(
      driver.identity,
      order.id,
      { fileId: pickupFile },
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    await h.orderLifecycle.confirmArrival(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const deliveryFile = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "DELIVERY_PROOF",
    );
    const results = await Promise.allSettled([
      h.orderLifecycle.confirmDelivery(
        driver.identity,
        order.id,
        { fileId: deliveryFile },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
      h.orderLifecycle.confirmDelivery(
        adminIdentity,
        order.id,
        {},
        { kind: "DASHBOARD", reason: "تسليم متزامن", actedOnBehalfOf: "DRIVER" },
        crypto.randomUUID(),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const row = await h.client<{ status: string; custody_status: string }[]>`
      select status::text, custody_status::text from orders where id = ${order.id}`;
    expect(row[0]).toMatchObject({
      status: "DELIVERED",
      custody_status: "WITH_CUSTOMER",
    });
    const events = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'ORDER_DELIVERED'`;
    expect(events[0]!.n).toBe(1);
    const assignments = await h.client<{ n: number }[]>`
      select count(*)::int n from order_driver_assignments
      where order_id = ${order.id} and status = 'COMPLETED'`;
    expect(assignments[0]!.n).toBe(1);
  });

  test("claimAsset failure leaves order status, custody, assignment and events unchanged", async () => {
    const { order, driver, assignmentId } = await approveAndClaimReady();
    const intentRes = await h.app.handle(
      jsonRequest(`/api/v1/mobile/driver/orders/${order.id}/proofs/upload-intent`, {
        token: driver.token,
        body: {
          assignmentId,
          purpose: "PICKUP_PROOF",
          contentType: "image/png",
          fileName: "pending.png",
          sizeBytes: PNG.length,
        },
      }),
    );
    const { fileId } = (await intentRes.json()) as { fileId: string };
    // Intentionally skip confirm → asset remains PENDING_UPLOAD / unclaimable.
    await expect(
      h.orderLifecycle.confirmPickup(
        driver.identity,
        order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "MEDIA_NOT_ATTACHABLE" });

    const row = await h.client<
      { status: string; custody_status: string; custody_driver_id: string | null }[]
    >`select status::text, custody_status::text, custody_driver_id::text
      from orders where id = ${order.id}`;
    expect(row[0]).toMatchObject({
      status: "READY_FOR_PICKUP",
      custody_status: "WITH_STORE",
      custody_driver_id: null,
    });
    const assignment = await h.client<{ status: string }[]>`
      select status::text from order_driver_assignments where id = ${assignmentId}`;
    expect(assignment[0]!.status).toBe("ASSIGNED");
    const picks = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'DRIVER_PICKED_UP'`;
    expect(picks[0]!.n).toBe(0);
  });

  test("reusing a consumed proof returns PROOF_ALREADY_USED", async () => {
    const { order, driver, assignmentId } = await approveAndClaimReady();
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    await h.client`
      update order_proofs set consumed_at = now()
      where media_asset_id = ${fileId}`;
    await expect(
      h.orderLifecycle.confirmPickup(
        driver.identity,
        order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "PROOF_ALREADY_USED" });
  });

  test("proof purpose mismatch returns PROOF_PURPOSE_MISMATCH", async () => {
    const { order, driver, assignmentId } = await approveAndClaimReady();
    const deliveryAsPickup = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "DELIVERY_PROOF",
    );
    await expect(
      h.orderLifecycle.confirmPickup(
        driver.identity,
        order.id,
        { fileId: deliveryAsPickup },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "PROOF_PURPOSE_MISMATCH" });
  });

  test("proof for a different assignment returns PROOF_ASSIGNMENT_MISMATCH", async () => {
    const first = await approveAndClaimReady();
    const second = await approveAndClaimReady();
    const fileId = await putReadyProof(
      first.driver.token,
      first.order.id,
      first.assignmentId,
      "PICKUP_PROOF",
    );
    await expect(
      h.orderLifecycle.confirmPickup(
        second.driver.identity,
        second.order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      publicCode: expect.stringMatching(
        /PROOF_ASSIGNMENT_MISMATCH|PROOF_NOT_FOUND/,
      ),
    });
  });

  test("proof belonging to another order is rejected", async () => {
    const first = await approveAndClaimReady();
    const second = await approveAndClaimReady();
    const fileId = await putReadyProof(
      first.driver.token,
      first.order.id,
      first.assignmentId,
      "PICKUP_PROOF",
    );
    await expect(
      h.orderLifecycle.confirmPickup(
        second.driver.identity,
        second.order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      publicCode: expect.stringMatching(
        /PROOF_ASSIGNMENT_MISMATCH|PROOF_NOT_FOUND/,
      ),
    });
  });

  test("proof uploaded by another driver is rejected", async () => {
    const { order, driver, assignmentId } = await approveAndClaimReady();
    const other = await freshDriver();
    // Upload intent requires assignment ownership — create proof row via SQL as other driver.
    const fileId = crypto.randomUUID();
    await h.client`
      insert into media_assets(
        id, city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at
      ) values (
        ${fileId}, ${city}, 'PICKUP_PROOF', 'PRIVATE', 'READY', ${`cities/${city}/x.png`},
        'x.png', 'image/png', ${PNG.length}, 'image/png', ${PNG.length},
        ${other.id}, now() + interval '1 hour', now()
      )`;
    await h.client`
      insert into order_proofs(
        order_id, assignment_id, city_id, media_asset_id, purpose, uploaded_by_driver_id
      ) values (
        ${order.id}, ${assignmentId}, ${city}, ${fileId}, 'PICKUP_PROOF', ${other.id}
      )`;
    await expect(
      h.orderLifecycle.confirmPickup(
        driver.identity,
        order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "PROOF_NOT_FOUND" });
  });

  test("database custody constraints reject impossible combinations", async () => {
    const order = await h.orders.create(customer, city, createBody());
    const assertRejects = async (label: string, run: () => Promise<unknown>) => {
      let failed = false;
      try {
        await run();
      } catch {
        failed = true;
      }
      expect(failed, label).toBe(true);
    };
    await assertRejects("WITH_DRIVER without driver id", () =>
      h.client`
        update orders
        set custody_status = 'WITH_DRIVER', custody_driver_id = null
        where id = ${order.id}`,
    );
    await assertRejects("WITH_STORE with driver id", () =>
      h.client`
        update orders
        set custody_status = 'WITH_STORE', custody_driver_id = ${customer}
        where id = ${order.id}`,
    );
    await assertRejects("WITH_CUSTOMER with driver id", () =>
      h.client`
        update orders
        set custody_status = 'WITH_CUSTOMER', custody_driver_id = ${customer}
        where id = ${order.id}`,
    );
  });

  test("dashboard cancel while custody with driver starts return workflow", async () => {
    const { order, driver, assignmentId } = await approveAndClaimReady();
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
    const cancelled = await h.orders.cancelByDashboard(
      adminIdentity,
      order.id,
      "محاولة إلغاء",
    );
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.custodyStatus).toBe("WITH_DRIVER");
    const row = await h.client<{ status: string; custody_status: string }[]>`
      select status::text, custody_status::text from orders where id = ${order.id}`;
    expect(row[0]).toMatchObject({
      status: "CANCELLED",
      custody_status: "WITH_DRIVER",
    });
    const assignment = await h.client<
      { status: string; completed_at: Date | null; cancelled_at: Date | null }[]
    >`select status::text, completed_at, cancelled_at from order_driver_assignments where id = ${assignmentId}`;
    expect(assignment[0]!.status).toBe("RETURN_PENDING");
    expect(assignment[0]!.completed_at).toBeNull();
    expect(assignment[0]!.cancelled_at).toBeNull();
    const workflow = await h.client<{ status: string }[]>`
      select status::text from order_return_workflows where order_id = ${order.id}`;
    expect(workflow[0]?.status).toBe("WAITING_FOR_DRIVER_RETURN");
  });

  test("lifecycle idempotency replay returns same payload without new event", async () => {
    const { order, driver, assignmentId } = await approveAndClaimReady();
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    const key = crypto.randomUUID();
    const first = await h.orderLifecycle.confirmPickup(
      driver.identity,
      order.id,
      { fileId },
      { kind: "DRIVER" },
      key,
    );
    const second = await h.orderLifecycle.confirmPickup(
      driver.identity,
      order.id,
      { fileId },
      { kind: "DRIVER" },
      key,
    );
    expect(second).toEqual(first);
    const events = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'DRIVER_PICKED_UP'`;
    expect(events[0]!.n).toBe(1);
  });

  test("same idempotency key with different payload returns IDEMPOTENCY_KEY_REUSED", async () => {
    const { order, driver, assignmentId } = await approveAndClaimReady();
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    const key = crypto.randomUUID();
    await h.orderLifecycle.confirmPickup(
      driver.identity,
      order.id,
      { fileId },
      { kind: "DRIVER" },
      key,
    );
    await expect(
      h.orderLifecycle.confirmPickup(
        driver.identity,
        order.id,
        { fileId, note: "different" },
        { kind: "DRIVER" },
        key,
      ),
    ).rejects.toMatchObject({ publicCode: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("idempotent retry preserves pickup timestamps and does not consume a second proof", async () => {
    const { order, driver, assignmentId } = await approveAndClaimReady();
    const fileId = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    const secondFile = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "PICKUP_PROOF",
    );
    const key = crypto.randomUUID();
    await h.orderLifecycle.confirmPickup(
      driver.identity,
      order.id,
      { fileId },
      { kind: "DRIVER" },
      key,
    );
    const [before] = await h.client<{ picked_up_at: Date }[]>`
      select picked_up_at from order_driver_assignments where id = ${assignmentId}`;
    await h.orderLifecycle.confirmPickup(
      driver.identity,
      order.id,
      { fileId },
      { kind: "DRIVER" },
      key,
    );
    const [after] = await h.client<{ picked_up_at: Date }[]>`
      select picked_up_at from order_driver_assignments where id = ${assignmentId}`;
    expect(new Date(after!.picked_up_at).getTime()).toBe(
      new Date(before!.picked_up_at).getTime(),
    );
    const consumed = await h.client<{ n: number }[]>`
      select count(*)::int n from order_proofs
      where assignment_id = ${assignmentId}
        and purpose = 'PICKUP_PROOF' and consumed_at is not null`;
    expect(consumed[0]!.n).toBe(1);
    const unused = await h.client<{ n: number }[]>`
      select count(*)::int n from order_proofs
      where media_asset_id = ${secondFile} and consumed_at is null`;
    expect(unused[0]!.n).toBe(1);
  });

  test("item mutation idempotency does not apply financial change twice", async () => {
    const order = await h.orders.create(customer, city, createBody());
    const before = order.productsSubtotal as number;
    const key = crypto.randomUUID();
    const body = { productId: product2, quantity: 1, reason: "إضافة" };
    const first = await h.orders.addItem(
      merchantIdentity,
      order.id,
      body,
      { kind: "MERCHANT", storeId: store },
      key,
    );
    const second = await h.orders.addItem(
      merchantIdentity,
      order.id,
      body,
      { kind: "MERCHANT", storeId: store },
      key,
    );
    expect(second.productsSubtotal).toBe(first.productsSubtotal);
    expect(first.productsSubtotal).toBe(before + 1500);
    const mutations = await h.client<{ n: number }[]>`
      select count(*)::int n from order_item_mutations
      where order_id = ${order.id} and mutation_type = 'ADD'`;
    expect(mutations[0]!.n).toBe(1);
  });

  test("approve idempotency does not open a second offer round", async () => {
    const order = await h.orders.create(customer, city, createBody());
    const key = crypto.randomUUID();
    await h.orders.approve(
      merchantIdentity,
      order.id,
      { kind: "MERCHANT", storeId: store },
      key,
    );
    await h.orders.approve(
      merchantIdentity,
      order.id,
      { kind: "MERCHANT", storeId: store },
      key,
    );
    const rounds = await h.client<{ n: number }[]>`
      select count(*)::int n from order_offer_rounds where order_id = ${order.id}`;
    expect(rounds[0]!.n).toBe(1);
    const events = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'STORE_APPROVED'`;
    expect(events[0]!.n).toBe(1);
  });
});
