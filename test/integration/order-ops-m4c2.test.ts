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

describe("M4-C2 order ops: remove, handoff, return, reopen", () => {
  let h: IntegrationHarness;
  let city = "";
  let store = "";
  let product = "";
  let customer = "";
  let addressId = "";
  let merchantIdentity!: AuthIdentity;
  let adminIdentity!: AuthIdentity;
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
      `+964772${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
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
        `ops-${id}`,
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
    const [assignment] = await h.client<
      { id: string; driver_fee: number }[]
    >`select id::text, driver_fee from order_driver_assignments
      where order_id = ${order.id} and completed_at is null and cancelled_at is null`;
    return {
      order,
      driver,
      assignmentId: assignment!.id,
      driverFee: Number(assignment!.driver_fee),
      roundId: round!.id,
    };
  };

  const pickupOrder = async (
    orderId: string,
    driver: { token: string; identity: AuthIdentity },
    assignmentId: string,
  ) => {
    const fileId = await putReadyProof(
      driver.token,
      orderId,
      assignmentId,
      "PICKUP_PROOF",
    );
    await h.orderLifecycle.confirmPickup(
      driver.identity,
      orderId,
      { fileId },
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
  };

  beforeAll(async () => {
    h = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_m4c2_ops",
    });
    city = await createActiveCity(h.client, "Ops City");
    const [actor] = await h.client<{ id: string }[]>`
      insert into accounts default values returning id`;
    superId = actor!.id;
    const bootstrapSuper: AuthIdentity = {
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
        ${city}, ${cat!.id}, 'Ops Store', '+9647004444444', 'Address',
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

    await h.deliveryPricing.create(bootstrapSuper, city, pricingInput);
    const versions = await h.deliveryPricing.list(bootstrapSuper, city);
    await h.deliveryPricing.activate(bootstrapSuper, city, versions[0]!.id);
    await h.cityDriverPricing.put(
      bootstrapSuper,
      city,
      {
        pricingBase: 3000,
        roundingUnit: 250,
        pricingStages: [{ afterSeconds: 0, increasePercentage: 0 }],
      },
      "ops-driver-pricing",
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
      email: "ops-admin@example.com",
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

    const superStaffId = await createStaffAccount(h.auth, h.client, {
      email: "ops-super@example.com",
      password: "fixed dashboard password",
      roles: ["SUPER_ADMIN"],
    });
    superIdentity = {
      accountId: superStaffId,
      sessionId: null as unknown as string,
      applicationType: "DASHBOARD",
      roles: ["SUPER_ADMIN"],
      scopeType: "GLOBAL",
      cityId: null,
      storeId: null,
    };

    const [m] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    await h.client`
      insert into merchant_profiles(account_id, store_id, city_id, display_name, status, created_by_account_id)
      values (${m!.id}, ${store}, ${city}, 'Ops Merchant', 'ACTIVE', ${superId})`;
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

  test("remove driver before pickup + REOFFER closes old assignment, creates new round, locks fee, skips second READY", async () => {
    const { order, assignmentId, driverFee } = await approveAndClaim();
    const removed = await h.orderOps.removeDriverBeforePickup(
      adminIdentity,
      order.id,
      {
        reason: "سائق غير متاح",
        nextAction: "REOFFER",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(removed.status).toBe("SEARCHING_DRIVER");
    expect(removed.lockedDriverFee).toBe(driverFee);
    expect(removed.storeReadyMarkedAt).toBeTruthy();

    const [old] = await h.client<{ status: string; cancelled_at: Date | null }[]>`
      select status::text, cancelled_at from order_driver_assignments where id = ${assignmentId}`;
    expect(old!.status).toBe("REMOVED_BEFORE_PICKUP");
    expect(old!.cancelled_at).toBeTruthy();

    const rounds = await h.client<{ id: string; status: string }[]>`
      select id::text, status::text from order_offer_rounds
      where order_id = ${order.id} order by opened_at`;
    expect(rounds.length).toBe(2);
    expect(rounds[1]!.status).toBe("OPEN");

    const replacement = await freshDriver();
    await h.offers.claim(
      replacement.identity,
      rounds[1]!.id,
      crypto.randomUUID(),
    );
    const [row] = await h.client<
      { status: string; locked_driver_fee: number; store_ready_marked_at: Date | null }[]
    >`select status::text, locked_driver_fee, store_ready_marked_at
      from orders where id = ${order.id}`;
    expect(row!.status).toBe("READY_FOR_PICKUP");
    expect(Number(row!.locked_driver_fee)).toBe(driverFee);
    expect(row!.store_ready_marked_at).toBeTruthy();

    const [newAssignment] = await h.client<{ driver_fee: number }[]>`
      select driver_fee from order_driver_assignments
      where order_id = ${order.id} and completed_at is null and cancelled_at is null`;
    expect(Number(newAssignment!.driver_fee)).toBe(driverFee);
  });

  test("remove + ASSIGN_DRIVER creates assignment without accept at same fee", async () => {
    const { order, assignmentId, driverFee } = await approveAndClaim();
    const next = await freshDriver();
    const result = await h.orderOps.removeDriverBeforePickup(
      adminIdentity,
      order.id,
      {
        reason: "تعيين بديل",
        nextAction: "ASSIGN_DRIVER",
        driverId: next.id,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(result.status).toBe("READY_FOR_PICKUP");
    expect(result.driverAccountId).toBe(next.id);
    expect(result.lockedDriverFee).toBe(driverFee);

    const [old] = await h.client<{ status: string }[]>`
      select status::text from order_driver_assignments where id = ${assignmentId}`;
    expect(old!.status).toBe("REMOVED_BEFORE_PICKUP");

    const [assigned] = await h.client<
      { status: string; driver_id: string; driver_fee: number; assignment_source: string }[]
    >`select status::text, driver_id::text, driver_fee, assignment_source::text
      from order_driver_assignments
      where order_id = ${order.id} and completed_at is null and cancelled_at is null`;
    expect(assigned).toMatchObject({
      status: "ASSIGNED",
      driver_id: next.id,
      assignment_source: "DASHBOARD_MANUAL",
    });
    expect(Number(assigned!.driver_fee)).toBe(driverFee);
  });

  test("admin can assign second active order; third rejected DRIVER_ACTIVE_ASSIGNMENT_LIMIT_REACHED", async () => {
    const driver = await freshDriver();
    const order1 = await h.orders.create(customer, city, createBody());
    await h.orders.approve(
      merchantIdentity,
      order1.id,
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    const [round1] = await h.client<{ id: string }[]>`
      select id::text from order_offer_rounds where order_id = ${order1.id}`;
    await h.offers.claim(driver.identity, round1!.id, crypto.randomUUID());

    const order2 = await h.orders.create(customer, city, createBody());
    await h.orders.approve(
      merchantIdentity,
      order2.id,
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    const assigned = await h.offers.assignDriver(
      adminIdentity,
      order2.id,
      { driverId: driver.id, reason: "PEAK_DEMAND" },
      crypto.randomUUID(),
    );
    expect(assigned.assignmentSequence).toBe(2);

    const order3 = await h.orders.create(customer, city, createBody());
    await h.orders.approve(
      merchantIdentity,
      order3.id,
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    await expect(
      h.offers.assignDriver(
        adminIdentity,
        order3.id,
        { driverId: driver.id, reason: "PEAK_DEMAND" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      publicCode: "DRIVER_ACTIVE_ASSIGNMENT_LIMIT_REACHED",
    });

    const { order: readyOrder } = await approveAndClaim();
    await expect(
      h.orderOps.removeDriverBeforePickup(adminIdentity, readyOrder.id, {
        reason: "تجاوز السعة",
        nextAction: "ASSIGN_DRIVER",
        driverId: driver.id,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({
      publicCode: "DRIVER_ACTIVE_ASSIGNMENT_LIMIT_REACHED",
    });
  });

  test("driver with active order cannot self-claim another offer", async () => {
    const { driver } = await approveAndClaim({ markReady: false });
    const other = await h.orders.create(customer, city, createBody());
    await h.orders.approve(
      merchantIdentity,
      other.id,
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    const [round] = await h.client<{ id: string }[]>`
      select id::text from order_offer_rounds where order_id = ${other.id}`;
    await expect(
      h.offers.claim(driver.identity, round!.id, crypto.randomUUID()),
    ).rejects.toMatchObject({ publicCode: "DRIVER_ACTIVE_ORDER_EXISTS" });
  });

  test("handoff after pickup: assign does not move custody; proof required for driver; dashboard completes", async () => {
    const { order, driver, assignmentId, driverFee } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    const replacement = await freshDriver();

    const started = await h.orderOps.startHandoffAssign(
      adminIdentity,
      order.id,
      {
        driverId: replacement.id,
        reason: "تبديل سائق",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(started.custodyStatus).toBe("WITH_DRIVER");
    expect(started.custodyDriverId).toBe(driver.id);
    expect(started.handoff?.status).toBe("PENDING");
    expect(started.lockedDriverFee).toBe(driverFee);

    const [toAssignment] = await h.client<{ id: string; status: string }[]>`
      select id::text, status::text from order_driver_assignments
      where order_id = ${order.id} and driver_id = ${replacement.id}
        and completed_at is null and cancelled_at is null`;
    expect(toAssignment!.status).toBe("HANDOFF_PENDING");

    await expect(
      h.orderOps.completeHandoff(
        replacement.identity,
        order.id,
        started.handoff!.id,
        { idempotencyKey: crypto.randomUUID() },
        { kind: "DRIVER" },
      ),
    ).rejects.toMatchObject({ publicCode: "PROOF_REQUIRED" });

    const completed = await h.orderOps.completeHandoff(
      adminIdentity,
      order.id,
      started.handoff!.id,
      {
        reason: "إكمال إداري",
        actedOnBehalfOf: "DRIVER",
        idempotencyKey: crypto.randomUUID(),
      },
      { kind: "DASHBOARD" },
    );
    expect(completed.custodyDriverId).toBe(replacement.id);
    expect(completed.custodyStatus).toBe("WITH_DRIVER");
    expect(completed.lockedDriverFee).toBe(driverFee);
    expect(completed.handoff?.status).toBe("COMPLETED");

    const [from] = await h.client<{ status: string; closing_reason: string }[]>`
      select status::text, closing_reason::text from order_driver_assignments
      where id = ${assignmentId}`;
    expect(from!.status).toBe("REPLACED_AFTER_PICKUP");
    expect(from!.closing_reason).toBe("REPLACED_AFTER_HANDOFF");

    const [to] = await h.client<{ status: string; driver_fee: number }[]>`
      select status::text, driver_fee from order_driver_assignments
      where id = ${toAssignment!.id}`;
    expect(to!.status).toBe("PICKED_UP");
    expect(Number(to!.driver_fee)).toBe(driverFee);
  });

  test("pending handoff freezes first driver delivery", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    await h.orderLifecycle.confirmArrival(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const replacement = await freshDriver();
    await h.orderOps.startHandoffAssign(adminIdentity, order.id, {
      driverId: replacement.id,
      reason: "تجميد التسليم",
      idempotencyKey: crypto.randomUUID(),
    });
    const deliveryFile = await putReadyProof(
      driver.token,
      order.id,
      assignmentId,
      "DELIVERY_PROOF",
    );
    await expect(
      h.orderLifecycle.confirmDelivery(
        driver.identity,
        order.id,
        { fileId: deliveryFile },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ publicCode: "DRIVER_HANDOFF_ALREADY_ACTIVE" });
  });

  test("cancel handoff keeps custody on first driver", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    const replacement = await freshDriver();
    const started = await h.orderOps.startHandoffAssign(
      adminIdentity,
      order.id,
      {
        driverId: replacement.id,
        reason: "بدء ثم إلغاء",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    const cancelled = await h.orderOps.cancelHandoff(
      adminIdentity,
      order.id,
      started.handoff!.id,
      { reason: "إلغاء التسليم", idempotencyKey: crypto.randomUUID() },
    );
    expect(cancelled.custodyDriverId).toBe(driver.id);
    expect(cancelled.custodyStatus).toBe("WITH_DRIVER");
    expect(cancelled.handoff?.status).toBe("CANCELLED");

    const [from] = await h.client<{ status: string; cancelled_at: Date | null }[]>`
      select status::text, cancelled_at from order_driver_assignments where id = ${assignmentId}`;
    expect(from!.status).toBe("PICKED_UP");
    expect(from!.cancelled_at).toBeNull();

    const [to] = await h.client<{ status: string; cancelled_at: Date | null }[]>`
      select status::text, cancelled_at from order_driver_assignments
      where order_id = ${order.id} and driver_id = ${replacement.id}`;
    expect(to!.status).toBe("CANCELLED");
    expect(to!.cancelled_at).toBeTruthy();
  });

  test("cancel after pickup starts return workflow and blocks delivery", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    await h.orderLifecycle.confirmArrival(
      driver.identity,
      order.id,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const cancelled = await h.orders.cancelByDashboard(
      adminIdentity,
      order.id,
      "إلغاء بعد الاستلام",
    );
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.custodyStatus).toBe("WITH_DRIVER");

    const [assignment] = await h.client<{ status: string }[]>`
      select status::text from order_driver_assignments where id = ${assignmentId}`;
    expect(assignment!.status).toBe("RETURN_PENDING");
    const [workflow] = await h.client<{ status: string }[]>`
      select status::text from order_return_workflows where order_id = ${order.id}`;
    expect(workflow!.status).toBe("WAITING_FOR_DRIVER_RETURN");

    await expect(
      h.orderLifecycle.confirmDelivery(
        driver.identity,
        order.id,
        { fileId: crypto.randomUUID() },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      publicCode: expect.stringMatching(
        /ORDER_ALREADY_CANCELLED|ASSIGNMENT_NOT_ACTIVE|RETURN_WORKFLOW_ALREADY_ACTIVE|DRIVER_ASSIGNMENT_REQUIRED/,
      ),
    });
  });

  test("return proof → store confirm → WITH_STORE; reopen REOFFER creates new attempt", async () => {
    const { order, driver, assignmentId, driverFee } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    await h.orders.cancelByDashboard(adminIdentity, order.id, "إرجاع للمتجر");

    const [workflow] = await h.client<{ id: string }[]>`
      select id::text from order_return_workflows where order_id = ${order.id}`;
    const returnFile = await putOpsProof(
      driver.token,
      order.id,
      assignmentId,
      "RETURN_PROOF",
      { returnWorkflowId: workflow!.id },
    );
    const afterDriver = await h.orderOps.confirmDriverReturn(
      driver.identity,
      order.id,
      { fileId: returnFile, idempotencyKey: crypto.randomUUID() },
      { kind: "DRIVER" },
    );
    expect(afterDriver.returnWorkflow?.status).toBe(
      "WAITING_FOR_STORE_CONFIRMATION",
    );

    const afterStore = await h.orderOps.confirmStoreReturn(
      merchantIdentity,
      order.id,
      { idempotencyKey: crypto.randomUUID() },
      { kind: "MERCHANT", storeId: store },
    );
    expect(afterStore.custodyStatus).toBe("WITH_STORE");
    expect(afterStore.custodyDriverId).toBeNull();
    expect(afterStore.returnWorkflow?.status).toBe("COMPLETED");

    const [closed] = await h.client<{ status: string; cancelled_at: Date | null }[]>`
      select status::text, cancelled_at from order_driver_assignments where id = ${assignmentId}`;
    expect(closed!.status).toBe("RETURNED_TO_STORE");
    expect(closed!.cancelled_at).toBeTruthy();

    const reopened = await h.orderOps.reopenOrder(adminIdentity, order.id, {
      reason: "إعادة فتح",
      nextAction: "REOFFER",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(reopened.status).toBe("SEARCHING_DRIVER");
    expect(reopened.lockedDriverFee).toBe(driverFee);

    const active = await h.client<{ id: string }[]>`
      select id::text from order_driver_assignments
      where order_id = ${order.id} and completed_at is null and cancelled_at is null`;
    expect(active.length).toBe(0);

    const [openRound] = await h.client<{ id: string }[]>`
      select id::text from order_offer_rounds
      where order_id = ${order.id} and status = 'OPEN'`;
    expect(openRound).toBeTruthy();
    const nextDriver = await freshDriver();
    await h.offers.claim(nextDriver.identity, openRound!.id, crypto.randomUUID());
    const [newAssignment] = await h.client<{ id: string; driver_id: string }[]>`
      select id::text, driver_id::text from order_driver_assignments
      where order_id = ${order.id} and completed_at is null and cancelled_at is null`;
    expect(newAssignment!.id).not.toBe(assignmentId);
    expect(newAssignment!.driver_id).toBe(nextDriver.id);
  });

  test("idempotency replay on remove-driver and complete-handoff", async () => {
    const { order } = await approveAndClaim();
    const removeKey = crypto.randomUUID();
    const firstRemove = await h.orderOps.removeDriverBeforePickup(
      adminIdentity,
      order.id,
      {
        reason: "إعادة تشغيل",
        nextAction: "REOFFER",
        idempotencyKey: removeKey,
      },
    );
    const secondRemove = await h.orderOps.removeDriverBeforePickup(
      adminIdentity,
      order.id,
      {
        reason: "إعادة تشغيل",
        nextAction: "REOFFER",
        idempotencyKey: removeKey,
      },
    );
    expect(secondRemove).toEqual(firstRemove);
    const removeEvents = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'DRIVER_REMOVED_BEFORE_PICKUP'`;
    expect(removeEvents[0]!.n).toBe(1);

    const ready = await approveAndClaim();
    await pickupOrder(ready.order.id, ready.driver, ready.assignmentId);
    const replacement = await freshDriver();
    const started = await h.orderOps.startHandoffAssign(
      adminIdentity,
      ready.order.id,
      {
        driverId: replacement.id,
        reason: "handoff idem",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    const handoffKey = crypto.randomUUID();
    const firstComplete = await h.orderOps.completeHandoff(
      adminIdentity,
      ready.order.id,
      started.handoff!.id,
      {
        reason: "إكمال",
        actedOnBehalfOf: "DRIVER",
        idempotencyKey: handoffKey,
      },
      { kind: "DASHBOARD" },
    );
    const secondComplete = await h.orderOps.completeHandoff(
      adminIdentity,
      ready.order.id,
      started.handoff!.id,
      {
        reason: "إكمال",
        actedOnBehalfOf: "DRIVER",
        idempotencyKey: handoffKey,
      },
      { kind: "DASHBOARD" },
    );
    expect(secondComplete).toEqual(firstComplete);
    expect(firstComplete.lockedDriverFee).toBe(ready.driverFee);
    const handoffEvents = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${ready.order.id} and event_type = 'HANDOFF_COMPLETED'`;
    expect(handoffEvents[0]!.n).toBe(1);
  });

  test("SUPER_ADMIN cannot call city ops (403)", async () => {
    const { order } = await approveAndClaim();
    await expect(
      h.orderOps.removeDriverBeforePickup(superIdentity, order.id, {
        reason: "سوبر أدمن ممنوع",
        nextAction: "REOFFER",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 403, publicCode: "FORBIDDEN" });
  });

  test("concurrent complete handoff driver+dashboard → one transition", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    const replacement = await freshDriver();
    const started = await h.orderOps.startHandoffAssign(
      adminIdentity,
      order.id,
      {
        driverId: replacement.id,
        reason: "متزامن",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    const [toAssignment] = await h.client<{ id: string }[]>`
      select id::text from order_driver_assignments
      where order_id = ${order.id} and driver_id = ${replacement.id}
        and status = 'HANDOFF_PENDING'`;
    const fileId = await putOpsProof(
      replacement.token,
      order.id,
      toAssignment!.id,
      "HANDOFF_PROOF",
      { handoffId: started.handoff!.id },
    );

    const results = await Promise.allSettled([
      h.orderOps.completeHandoff(
        replacement.identity,
        order.id,
        started.handoff!.id,
        { fileId, idempotencyKey: crypto.randomUUID() },
        { kind: "DRIVER" },
      ),
      h.orderOps.completeHandoff(
        adminIdentity,
        order.id,
        started.handoff!.id,
        {
          reason: "إكمال متزامن",
          actedOnBehalfOf: "DRIVER",
          idempotencyKey: crypto.randomUUID(),
        },
        { kind: "DASHBOARD" },
      ),
    ]);
    expect(
      results.filter((r) => r.status === "fulfilled").length,
    ).toBeGreaterThanOrEqual(1);

    const [row] = await h.client<
      { custody_driver_id: string; custody_status: string }[]
    >`select custody_driver_id::text, custody_status::text from orders where id = ${order.id}`;
    expect(row).toMatchObject({
      custody_driver_id: replacement.id,
      custody_status: "WITH_DRIVER",
    });
    const events = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${order.id} and event_type = 'HANDOFF_COMPLETED'`;
    expect(events[0]!.n).toBe(1);
    const handoffs = await h.client<{ n: number }[]>`
      select count(*)::int n from order_driver_handoffs
      where order_id = ${order.id} and status = 'COMPLETED'`;
    expect(handoffs[0]!.n).toBe(1);
  });
});
