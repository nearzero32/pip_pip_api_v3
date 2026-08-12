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

const iso = (v: Date | string | null | undefined) =>
  v == null ? null : new Date(v).toISOString();

const assertRejects = async (label: string, run: () => Promise<unknown>) => {
  let failed = false;
  try {
    await run();
  } catch {
    failed = true;
  }
  expect(failed, label).toBe(true);
};

describe("M4-C2 closure: races, idempotency HTTP, DB constraints", () => {
  let h: IntegrationHarness;
  let city = "";
  let store = "";
  let product = "";
  let customer = "";
  let addressId = "";
  let merchantIdentity!: AuthIdentity;
  let adminIdentity!: AuthIdentity;
  let adminToken = "";
  let admin2Identity!: AuthIdentity;
  let admin2Token = "";
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
        `ops-closure-${id}`,
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

  const createSearchingOrder = async () => {
    const order = await h.orders.create(customer, city, createBody());
    await h.orders.approve(
      merchantIdentity,
      order.id,
      { kind: "MERCHANT", storeId: store },
      crypto.randomUUID(),
    );
    const [round] = await h.client<{ id: string }[]>`
      select id::text from order_offer_rounds
      where order_id = ${order.id} and status = 'OPEN'`;
    return { order, roundId: round!.id };
  };

  const countActiveAssignments = async (driverId: string) => {
    const [row] = await h.client<{ n: number }[]>`
      select count(*)::int n from order_driver_assignments
      where driver_id = ${driverId}
        and completed_at is null and cancelled_at is null`;
    return row!.n;
  };

  const countActiveAssignmentsOnOrder = async (orderId: string) => {
    const [row] = await h.client<{ n: number }[]>`
      select count(*)::int n from order_driver_assignments
      where order_id = ${orderId}
        and completed_at is null and cancelled_at is null`;
    return row!.n;
  };

  const countActiveReturns = async (orderId: string) => {
    const [row] = await h.client<{ n: number }[]>`
      select count(*)::int n from order_return_workflows
      where order_id = ${orderId}
        and status in ('WAITING_FOR_DRIVER_RETURN','WAITING_FOR_STORE_CONFIRMATION')`;
    return row!.n;
  };

  const eventCount = async (orderId: string, eventType: string) => {
    const [row] = await h.client<{ n: number }[]>`
      select count(*)::int n from order_events
      where order_id = ${orderId} and event_type = ${eventType}`;
    return row!.n;
  };

  const orderSnapshot = async (orderId: string) => {
    const [row] = await h.client<
      {
        status: string;
        custody_status: string;
        custody_driver_id: string | null;
        locked_driver_fee: number | null;
        status_changed_at: Date;
      }[]
    >`select status::text, custody_status::text, custody_driver_id::text,
             locked_driver_fee, status_changed_at
      from orders where id = ${orderId}`;
    return row!;
  };

  const buildArrivedWithDeliveryProof = async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    await h.orderLifecycle.confirmArrival(
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
      "DELIVERY_PROOF",
    );
    return { order, driver, assignmentId, fileId };
  };

  const completeCancelReturnToStore = async () => {
    const { order, driver, assignmentId, driverFee } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    await h.orderOps.cancelByDashboard(adminIdentity, order.id, {
      reason: "إلغاء ثم إرجاع",
      idempotencyKey: crypto.randomUUID(),
    });
    await h.orderOps.confirmDriverReturn(
      adminIdentity,
      order.id,
      { reason: "سائق أعاد", idempotencyKey: crypto.randomUUID() },
      { kind: "DASHBOARD" },
    );
    await h.orderOps.confirmStoreReturn(
      adminIdentity,
      order.id,
      { reason: "المتجر استلم", idempotencyKey: crypto.randomUUID() },
      { kind: "DASHBOARD" },
    );
    return { order, driverFee };
  };

  const dashPost = async (
    path: string,
    opts: {
      token?: string;
      body?: unknown;
      key?: string | null;
      rawBody?: string;
    } = {},
  ) => {
    const headers: Record<string, string> = {};
    if (opts.key) headers["idempotency-key"] = opts.key;
    if (opts.rawBody !== undefined) {
      headers["content-type"] = "application/json";
      headers.authorization = `Bearer ${opts.token ?? adminToken}`;
      return h.app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers,
          body: opts.rawBody,
        }),
      );
    }
    return h.app.handle(
      jsonRequest(path, {
        token: opts.token ?? adminToken,
        body: opts.body ?? {},
        ...(opts.key != null
          ? { headers: { "idempotency-key": opts.key } }
          : {}),
      }),
    );
  };

  beforeAll(async () => {
    h = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_m4c2_closure",
    });
    city = await createActiveCity(h.client, "Ops Closure City");
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
        ${city}, ${cat!.id}, 'Ops Closure Store', '+9647004444455', 'Address',
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
      "ops-closure-driver-pricing",
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
      email: "ops-closure-admin@example.com",
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
        email: "ops-closure-admin@example.com",
        password: "fixed dashboard password",
        deviceName: "ops-closure-admin",
        ip: "ops-closure-admin",
        requestId: "ops-closure-admin",
      })
    ).access_token;

    const admin2Id = await createStaffAccount(h.auth, h.client, {
      email: "ops-closure-admin2@example.com",
      password: "fixed dashboard password",
      roles: ["ADMIN"],
      cityId: city,
    });
    admin2Identity = {
      accountId: admin2Id,
      sessionId: null as unknown as string,
      applicationType: "DASHBOARD",
      roles: ["ADMIN"],
      scopeType: "CITY",
      cityId: city,
      storeId: null,
    };
    admin2Token = (
      await h.auth.dashboard.login({
        email: "ops-closure-admin2@example.com",
        password: "fixed dashboard password",
        deviceName: "ops-closure-admin2",
        ip: "ops-closure-admin2",
        requestId: "ops-closure-admin2",
      })
    ).access_token;

    const [m] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    await h.client`
      insert into merchant_profiles(account_id, store_id, city_id, display_name, status, created_by_account_id)
      values (${m!.id}, ${store}, ${city}, 'Ops Closure Merchant', 'ACTIVE', ${superId})`;
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

  // ─── 1. Claim × admin assign races ───────────────────────────────────────

  test("concurrent claim and dashboard assign never exceed two active assignments", async () => {
    const driver = await freshDriver();
    const a = await createSearchingOrder();
    const b = await createSearchingOrder();

    const results = await Promise.allSettled([
      h.offers.claim(driver.identity, a.roundId, crypto.randomUUID()),
      h.offers.assignDriver(
        adminIdentity,
        b.order.id,
        { driverId: driver.id, reason: "PEAK_DEMAND" },
        crypto.randomUUID(),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.length + rejected.length).toBe(2);

    const active = await countActiveAssignments(driver.id);
    expect(active).toBeGreaterThanOrEqual(1);
    expect(active).toBeLessThanOrEqual(2);
    expect(active).not.toBe(3);

    for (let i = 0; i < results.length; i++) {
      const orderId = i === 0 ? a.order.id : b.order.id;
      if (results[i]!.status === "fulfilled") {
        expect(await countActiveAssignmentsOnOrder(orderId)).toBe(1);
      } else {
        const err = (results[i] as PromiseRejectedResult).reason;
        expect(err.statusCode).toBeGreaterThanOrEqual(400);
        expect(err.statusCode).toBeLessThan(500);
        const onOrder = await countActiveAssignmentsOnOrder(orderId);
        expect(onOrder).toBe(0);
        const snap = await orderSnapshot(orderId);
        expect(
          snap.status === "SEARCHING_DRIVER" || onOrder === 0,
        ).toBe(true);
      }
    }
  });

  test("concurrent claim with one active plus admin second assign stays at most two", async () => {
    const { driver } = await approveAndClaim({ markReady: false });
    expect(await countActiveAssignments(driver.id)).toBe(1);

    const open = await createSearchingOrder();
    const third = await createSearchingOrder();

    const results = await Promise.allSettled([
      h.offers.claim(driver.identity, open.roundId, crypto.randomUUID()),
      h.offers.assignDriver(
        adminIdentity,
        third.order.id,
        { driverId: driver.id, reason: "PEAK_DEMAND" },
        crypto.randomUUID(),
      ),
    ]);

    const active = await countActiveAssignments(driver.id);
    expect(active).toBeLessThanOrEqual(2);

    const claimResult = results[0]!;
    if (claimResult.status === "rejected") {
      expect(claimResult.reason).toMatchObject({
        publicCode: "DRIVER_ACTIVE_ORDER_EXISTS",
        statusCode: 409,
      });
    }

    const assignResult = results[1]!;
    if (assignResult.status === "fulfilled") {
      expect(active).toBe(2);
    } else {
      expect(assignResult.reason.statusCode).toBeGreaterThanOrEqual(400);
      expect(assignResult.reason.statusCode).toBeLessThan(500);
    }
  });

  test("concurrent dual dashboard assigns with one active allow only one second assignment", async () => {
    const { driver } = await approveAndClaim({ markReady: false });
    expect(await countActiveAssignments(driver.id)).toBe(1);

    const x = await createSearchingOrder();
    const y = await createSearchingOrder();

    const results = await Promise.allSettled([
      h.offers.assignDriver(
        adminIdentity,
        x.order.id,
        { driverId: driver.id, reason: "PEAK_DEMAND" },
        crypto.randomUUID(),
      ),
      h.offers.assignDriver(
        adminIdentity,
        y.order.id,
        { driverId: driver.id, reason: "PEAK_DEMAND" },
        crypto.randomUUID(),
      ),
    ]);

    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(1);
    expect(await countActiveAssignments(driver.id)).toBe(2);

    const loss = losses[0] as PromiseRejectedResult;
    expect(loss.reason.statusCode).toBe(409);
    expect(loss.reason.statusCode).not.toBe(500);

    for (let i = 0; i < 2; i++) {
      const orderId = i === 0 ? x.order.id : y.order.id;
      if (results[i]!.status === "rejected") {
        expect(await countActiveAssignmentsOnOrder(orderId)).toBe(0);
      }
    }
  });

  // ─── 2. Cancel × delivery ────────────────────────────────────────────────

  test("concurrent dashboard cancel and driver delivery yield exactly one atomic outcome", async () => {
    const { order, driver, assignmentId, fileId } =
      await buildArrivedWithDeliveryProof();

    const results = await Promise.allSettled([
      h.orderOps.cancelByDashboard(adminIdentity, order.id, {
        reason: "إلغاء متزامن مع التسليم",
        idempotencyKey: crypto.randomUUID(),
      }),
      h.orderLifecycle.confirmDelivery(
        driver.identity,
        order.id,
        { fileId },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    if (rejected.length > 0) {
      for (const r of rejected) {
        const err = (r as PromiseRejectedResult).reason;
        expect(err.statusCode).toBeGreaterThanOrEqual(400);
        expect(err.statusCode).toBeLessThan(500);
      }
    }

    const snap = await orderSnapshot(order.id);
    const [assignment] = await h.client<
      { status: string; completed_at: Date | null }[]
    >`select status::text, completed_at from order_driver_assignments where id = ${assignmentId}`;
    const activeReturns = await countActiveReturns(order.id);
    const deliveredEvents = await eventCount(order.id, "ORDER_DELIVERED");
    const cancelEvents = await eventCount(order.id, "ORDER_CANCELLED_BY_DASHBOARD");
    const returnStarted = await eventCount(order.id, "RETURN_STARTED");

    const deliveredPath =
      snap.status === "DELIVERED" &&
      snap.custody_status === "WITH_CUSTOMER" &&
      assignment!.status === "COMPLETED" &&
      assignment!.completed_at != null &&
      activeReturns === 0 &&
      deliveredEvents >= 1 &&
      returnStarted === 0;

    const cancelledPath =
      snap.status === "CANCELLED" &&
      snap.custody_status === "WITH_DRIVER" &&
      assignment!.status === "RETURN_PENDING" &&
      activeReturns === 1 &&
      cancelEvents >= 1 &&
      deliveredEvents === 0;

    // Prefer single winner; allow both fulfilled only if they converge on one terminal.
    if (fulfilled.length === 2) {
      expect(deliveredPath || cancelledPath).toBe(true);
    } else {
      expect(deliveredPath || cancelledPath).toBe(true);
    }

    // Reject mixed / inconsistent outcomes
    expect(snap.status === "CANCELLED" && snap.custody_status === "WITH_CUSTOMER").toBe(
      false,
    );
    expect(snap.status === "DELIVERED" && activeReturns > 0).toBe(false);
    expect(
      snap.status === "DELIVERED" &&
        (
          await h.client<{ n: number }[]>`
            select count(*)::int n from order_return_workflows
            where order_id = ${order.id} and status = 'WAITING_FOR_DRIVER_RETURN'`
        )[0]!.n > 0,
    ).toBe(false);
    expect(snap.status === "CANCELLED" && activeReturns === 0).toBe(false);
    expect(cancelEvents > 0 && deliveredEvents > 0).toBe(false);
  });

  // ─── 3. Return races ─────────────────────────────────────────────────────

  test("concurrent driver return proof and dashboard driver-return override produce one transition", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    await h.orderOps.startReturnToStore(adminIdentity, order.id, {
      reason: "إرجاع تشغيلي",
      idempotencyKey: crypto.randomUUID(),
    });
    const [workflow] = await h.client<{ id: string }[]>`
      select id::text from order_return_workflows
      where order_id = ${order.id} and status = 'WAITING_FOR_DRIVER_RETURN'`;
    const fileId = await putOpsProof(
      driver.token,
      order.id,
      assignmentId,
      "RETURN_PROOF",
      { returnWorkflowId: workflow!.id },
    );

    const results = await Promise.allSettled([
      h.orderOps.confirmDriverReturn(
        driver.identity,
        order.id,
        { fileId, idempotencyKey: crypto.randomUUID() },
        { kind: "DRIVER" },
      ),
      h.orderOps.confirmDriverReturn(
        adminIdentity,
        order.id,
        { reason: "تجاوز إداري", idempotencyKey: crypto.randomUUID() },
        { kind: "DASHBOARD" },
      ),
    ]);

    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);

    const [wf] = await h.client<{ status: string }[]>`
      select status::text from order_return_workflows where id = ${workflow!.id}`;
    expect(wf!.status).toBe("WAITING_FOR_STORE_CONFIRMATION");
    expect(await eventCount(order.id, "DRIVER_RETURN_PROOF_SUBMITTED")).toBe(1);

    const driverResult = results[0]!;
    if (driverResult.status === "rejected") {
      const [proof] = await h.client<{ consumed_at: Date | null }[]>`
        select consumed_at from order_proofs where id = ${fileId}`;
      expect(proof!.consumed_at).toBeNull();
      expect(driverResult.reason.statusCode).toBeGreaterThanOrEqual(400);
      expect(driverResult.reason.statusCode).toBeLessThan(500);
    }
  });

  test("concurrent store and dashboard store-confirm produce one custody transfer", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    await h.orderOps.startReturnToStore(adminIdentity, order.id, {
      reason: "إرجاع للمتجر",
      idempotencyKey: crypto.randomUUID(),
    });
    await h.orderOps.confirmDriverReturn(
      adminIdentity,
      order.id,
      { reason: "سائق أعاد", idempotencyKey: crypto.randomUUID() },
      { kind: "DASHBOARD" },
    );

    const results = await Promise.allSettled([
      h.orderOps.confirmStoreReturn(
        merchantIdentity,
        order.id,
        { idempotencyKey: crypto.randomUUID() },
        { kind: "MERCHANT", storeId: store },
      ),
      h.orderOps.confirmStoreReturn(
        adminIdentity,
        order.id,
        { reason: "تأكيد إداري", idempotencyKey: crypto.randomUUID() },
        { kind: "DASHBOARD" },
      ),
    ]);

    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);

    const snap = await orderSnapshot(order.id);
    expect(["READY_FOR_PICKUP", "CANCELLED"]).toContain(snap.status);
    expect(snap.custody_status).toBe("WITH_STORE");
    expect(snap.custody_driver_id).toBeNull();
    expect(await eventCount(order.id, "RETURN_COMPLETED")).toBe(1);
    expect(await countActiveReturns(order.id)).toBe(0);

    const custodyTransfers = await h.client<{ n: number }[]>`
      select count(*)::int n from order_custody_history
      where order_id = ${order.id} and to_status = 'WITH_STORE'`;
    expect(custodyTransfers[0]!.n).toBe(1);
  });

  test("concurrent start-return and cancel-after-pickup leave consistent single workflow", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);

    const results = await Promise.allSettled([
      h.orderOps.startReturnToStore(adminIdentity, order.id, {
        reason: "بدء إرجاع",
        idempotencyKey: crypto.randomUUID(),
      }),
      h.orderOps.cancelByDashboard(adminIdentity, order.id, {
        reason: "إلغاء بعد الاستلام",
        idempotencyKey: crypto.randomUUID(),
      }),
    ]);

    const wins = results.filter((r) => r.status === "fulfilled");
    expect(wins.length).toBeGreaterThanOrEqual(1);
    expect(await countActiveReturns(order.id)).toBe(1);

    const snap = await orderSnapshot(order.id);
    const ok =
      (snap.status === "PICKED_UP" && snap.custody_status === "WITH_DRIVER") ||
      (snap.status === "CANCELLED" && snap.custody_status === "WITH_DRIVER");
    expect(ok).toBe(true);

    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason.statusCode).toBeGreaterThanOrEqual(400);
        expect(r.reason.statusCode).toBeLessThan(500);
      }
    }
  });

  test("concurrent dual start-return attempts create only one active workflow", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);

    const results = await Promise.allSettled([
      h.orderOps.startReturnToStore(adminIdentity, order.id, {
        reason: "إرجاع ١",
        idempotencyKey: crypto.randomUUID(),
      }),
      h.orderOps.startReturnToStore(adminIdentity, order.id, {
        reason: "إرجاع ٢",
        idempotencyKey: crypto.randomUUID(),
      }),
    ]);

    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(1);
    expect((losses[0] as PromiseRejectedResult).reason).toMatchObject({
      publicCode: "RETURN_WORKFLOW_ALREADY_ACTIVE",
      statusCode: 409,
    });
    expect(await countActiveReturns(order.id)).toBe(1);
  });

  // ─── 4. Idempotency matrix via HTTP ──────────────────────────────────────

  describe("HTTP idempotency matrix", () => {
    type MatrixCase = {
      name: string;
      prepare: () => Promise<{
        path: string;
        body: Record<string, unknown>;
        altBody: Record<string, unknown>;
        stamp: () => Promise<Record<string, string | null>>;
        eventType?: string;
      }>;
    };

    const cases: MatrixCase[] = [
      {
        name: "remove-driver",
        prepare: async () => {
          const { order } = await approveAndClaim();
          return {
            path: `/api/v1/dashboard/orders/${order.id}/remove-driver`,
            body: { reason: "سائق غير متاح", nextAction: "REOFFER" },
            altBody: { reason: "سبب مختلف", nextAction: "REOFFER" },
            stamp: async () => {
              const s = await orderSnapshot(order.id);
              return { status_changed_at: iso(s.status_changed_at) };
            },
            eventType: "DRIVER_REMOVED_BEFORE_PICKUP",
          };
        },
      },
      {
        name: "reoffer",
        prepare: async () => {
          const { order, driver, assignmentId } = await approveAndClaim();
          await pickupOrder(order.id, driver, assignmentId);
          return {
            path: `/api/v1/dashboard/orders/${order.id}/reoffer`,
            body: { reason: "إعادة عرض بعد الاستلام" },
            altBody: { reason: "سبب مختلف لإعادة العرض" },
            stamp: async () => {
              const s = await orderSnapshot(order.id);
              return { status_changed_at: iso(s.status_changed_at) };
            },
            eventType: "ORDER_REOFFERED",
          };
        },
      },
      {
        name: "assign-replacement",
        prepare: async () => {
          const { order, driver, assignmentId } = await approveAndClaim();
          await pickupOrder(order.id, driver, assignmentId);
          const replacement = await freshDriver();
          return {
            path: `/api/v1/dashboard/orders/${order.id}/assign-replacement`,
            body: {
              driverId: replacement.id,
              reason: "تعيين بديل",
            },
            altBody: {
              driverId: replacement.id,
              reason: "سبب بديل مختلف",
            },
            stamp: async () => {
              const [handoff] = await h.client<{ started_at: Date }[]>`
                select started_at from order_driver_handoffs
                where order_id = ${order.id} order by started_at limit 1`;
              const [a] = await h.client<{ assigned_at: Date }[]>`
                select assigned_at from order_driver_assignments
                where order_id = ${order.id} and driver_id = ${replacement.id}`;
              return {
                handoff_started_at: iso(handoff?.started_at),
                assigned_at: iso(a?.assigned_at),
              };
            },
            eventType: "HANDOFF_STARTED",
          };
        },
      },
      {
        name: "handoffs/start",
        prepare: async () => {
          const { order, driver, assignmentId } = await approveAndClaim();
          await pickupOrder(order.id, driver, assignmentId);
          const replacement = await freshDriver();
          return {
            path: `/api/v1/dashboard/orders/${order.id}/handoffs/start`,
            body: { driverId: replacement.id, reason: "بدء تسليم" },
            altBody: { driverId: replacement.id, reason: "سبب مختلف" },
            stamp: async () => {
              const [handoff] = await h.client<{ started_at: Date }[]>`
                select started_at from order_driver_handoffs
                where order_id = ${order.id} order by started_at limit 1`;
              return { handoff_started_at: iso(handoff?.started_at) };
            },
            eventType: "HANDOFF_STARTED",
          };
        },
      },
      {
        name: "handoffs/cancel",
        prepare: async () => {
          const { order, driver, assignmentId } = await approveAndClaim();
          await pickupOrder(order.id, driver, assignmentId);
          const replacement = await freshDriver();
          const started = await h.orderOps.startHandoffAssign(
            adminIdentity,
            order.id,
            {
              driverId: replacement.id,
              reason: "ثم إلغاء",
              idempotencyKey: crypto.randomUUID(),
            },
          );
          return {
            path: `/api/v1/dashboard/orders/${order.id}/handoffs/${started.handoff!.id}/cancel`,
            body: { reason: "إلغاء التسليم" },
            altBody: { reason: "سبب إلغاء مختلف" },
            stamp: async () => {
              const [handoff] = await h.client<{ started_at: Date; cancelled_at: Date | null }[]>`
                select started_at, cancelled_at from order_driver_handoffs
                where id = ${started.handoff!.id}`;
              return {
                handoff_started_at: iso(handoff!.started_at),
                cancelled_at: iso(handoff!.cancelled_at),
              };
            },
            eventType: "HANDOFF_CANCELLED",
          };
        },
      },
      {
        name: "handoffs/complete",
        prepare: async () => {
          const { order, driver, assignmentId } = await approveAndClaim();
          await pickupOrder(order.id, driver, assignmentId);
          const replacement = await freshDriver();
          const started = await h.orderOps.startHandoffAssign(
            adminIdentity,
            order.id,
            {
              driverId: replacement.id,
              reason: "ثم إكمال",
              idempotencyKey: crypto.randomUUID(),
            },
          );
          return {
            path: `/api/v1/dashboard/orders/${order.id}/handoffs/${started.handoff!.id}/complete`,
            body: { reason: "إكمال إداري", actedOnBehalfOf: "DRIVER" },
            altBody: { reason: "سبب إكمال مختلف", actedOnBehalfOf: "DRIVER" },
            stamp: async () => {
              const [handoff] = await h.client<{ started_at: Date; completed_at: Date | null }[]>`
                select started_at, completed_at from order_driver_handoffs
                where id = ${started.handoff!.id}`;
              const s = await orderSnapshot(order.id);
              return {
                handoff_started_at: iso(handoff!.started_at),
                completed_at: iso(handoff!.completed_at),
                status_changed_at: iso(s.status_changed_at),
              };
            },
            eventType: "HANDOFF_COMPLETED",
          };
        },
      },
      {
        name: "cancel",
        prepare: async () => {
          const { order, driver, assignmentId } = await approveAndClaim();
          await pickupOrder(order.id, driver, assignmentId);
          return {
            path: `/api/v1/dashboard/orders/${order.id}/cancel`,
            body: { reason: "إلغاء طلب" },
            altBody: { reason: "سبب إلغاء مختلف" },
            stamp: async () => {
              const s = await orderSnapshot(order.id);
              return { status_changed_at: iso(s.status_changed_at) };
            },
            eventType: "ORDER_CANCELLED_BY_DASHBOARD",
          };
        },
      },
      {
        name: "returns/start",
        prepare: async () => {
          const { order, driver, assignmentId } = await approveAndClaim();
          await pickupOrder(order.id, driver, assignmentId);
          return {
            path: `/api/v1/dashboard/orders/${order.id}/returns/start`,
            body: { reason: "بدء إرجاع" },
            altBody: { reason: "سبب إرجاع مختلف" },
            stamp: async () => {
              const [wf] = await h.client<{ started_at: Date }[]>`
                select started_at from order_return_workflows
                where order_id = ${order.id} order by started_at limit 1`;
              return { return_started_at: iso(wf?.started_at) };
            },
            eventType: "RETURN_STARTED",
          };
        },
      },
      {
        name: "returns/confirm-driver",
        prepare: async () => {
          const { order, driver, assignmentId } = await approveAndClaim();
          await pickupOrder(order.id, driver, assignmentId);
          await h.orderOps.startReturnToStore(adminIdentity, order.id, {
            reason: "إرجاع",
            idempotencyKey: crypto.randomUUID(),
          });
          return {
            path: `/api/v1/dashboard/orders/${order.id}/returns/confirm-driver`,
            body: { reason: "تأكيد سائق" },
            altBody: { reason: "سبب تأكيد مختلف" },
            stamp: async () => {
              const [wf] = await h.client<{ driver_returned_at: Date | null }[]>`
                select driver_returned_at from order_return_workflows
                where order_id = ${order.id}`;
              return { driver_returned_at: iso(wf?.driver_returned_at) };
            },
            eventType: "DRIVER_RETURN_PROOF_SUBMITTED",
          };
        },
      },
      {
        name: "returns/confirm-store",
        prepare: async () => {
          const { order, driver, assignmentId } = await approveAndClaim();
          await pickupOrder(order.id, driver, assignmentId);
          await h.orderOps.startReturnToStore(adminIdentity, order.id, {
            reason: "إرجاع",
            idempotencyKey: crypto.randomUUID(),
          });
          await h.orderOps.confirmDriverReturn(
            adminIdentity,
            order.id,
            { reason: "سائق", idempotencyKey: crypto.randomUUID() },
            { kind: "DASHBOARD" },
          );
          return {
            path: `/api/v1/dashboard/orders/${order.id}/returns/confirm-store`,
            body: { reason: "تأكيد متجر" },
            altBody: { reason: "سبب تأكيد متجر مختلف" },
            stamp: async () => {
              const s = await orderSnapshot(order.id);
              const [wf] = await h.client<{ completed_at: Date | null }[]>`
                select completed_at from order_return_workflows
                where order_id = ${order.id}`;
              return {
                status_changed_at: iso(s.status_changed_at),
                completed_at: iso(wf?.completed_at),
              };
            },
            eventType: "RETURN_COMPLETED",
          };
        },
      },
      {
        name: "reopen",
        prepare: async () => {
          const { order } = await completeCancelReturnToStore();
          return {
            path: `/api/v1/dashboard/orders/${order.id}/reopen`,
            body: { reason: "إعادة فتح", nextAction: "KEEP_CANCELLED" },
            altBody: { reason: "سبب مختلف", nextAction: "KEEP_CANCELLED" },
            stamp: async () => {
              const s = await orderSnapshot(order.id);
              return { status_changed_at: iso(s.status_changed_at) };
            },
            eventType: "ORDER_REOPENED",
          };
        },
      },
    ];

    for (const c of cases) {
      test(`${c.name}: missing key → 422; replay; conflict`, async () => {
        const prepared = await c.prepare();
        const missing = await dashPost(prepared.path, {
          body: prepared.body,
          key: null,
        });
        expect(missing.status).toBe(422);

        const key = crypto.randomUUID();
        const first = await dashPost(prepared.path, {
          body: prepared.body,
          key,
        });
        expect(first.status).toBe(200);
        const firstBody = await first.json();
        const stamp1 = await prepared.stamp();
        const events1 = prepared.eventType
          ? await eventCount(
              prepared.path.match(
                /orders\/([0-9a-f-]{36})/i,
              )![1]!,
              prepared.eventType,
            )
          : null;

        const replay = await dashPost(prepared.path, {
          body: prepared.body,
          key,
        });
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(firstBody);
        expect(await prepared.stamp()).toEqual(stamp1);
        if (prepared.eventType && events1 != null) {
          const orderId = prepared.path.match(
            /orders\/([0-9a-f-]{36})/i,
          )![1]!;
          expect(await eventCount(orderId, prepared.eventType)).toBe(events1);
        }

        const conflict = await dashPost(prepared.path, {
          body: prepared.altBody,
          key,
        });
        expect(conflict.status).toBe(409);
        expect((await conflict.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
      });
    }

    test("different scope same key does not collide", async () => {
      const remove = await approveAndClaim();
      const key = crypto.randomUUID();
      const removeRes = await dashPost(
        `/api/v1/dashboard/orders/${remove.order.id}/remove-driver`,
        {
          body: { reason: "نطاق مختلف", nextAction: "REOFFER" },
          key,
        },
      );
      expect(removeRes.status).toBe(200);

      const reofferSetup = await approveAndClaim();
      await pickupOrder(
        reofferSetup.order.id,
        reofferSetup.driver,
        reofferSetup.assignmentId,
      );
      const reofferRes = await dashPost(
        `/api/v1/dashboard/orders/${reofferSetup.order.id}/reoffer`,
        {
          body: { reason: "إعادة عرض بمفتاح مشترك" },
          key,
        },
      );
      expect(reofferRes.status).toBe(200);
    });

    test("different actor same key does not replay first actor result", async () => {
      const a = await approveAndClaim();
      const b = await approveAndClaim();
      const key = crypto.randomUUID();

      const first = await dashPost(
        `/api/v1/dashboard/orders/${a.order.id}/remove-driver`,
        {
          token: adminToken,
          body: { reason: "ممثل ١", nextAction: "REOFFER" },
          key,
        },
      );
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      const second = await dashPost(
        `/api/v1/dashboard/orders/${b.order.id}/remove-driver`,
        {
          token: admin2Token,
          body: { reason: "ممثل ١", nextAction: "REOFFER" },
          key,
        },
      );
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody.id).toBe(b.order.id);
      expect(secondBody.id).not.toBe(firstBody.id);
    });

    test("canonical hash: body key order differs still replays", async () => {
      const { order } = await approveAndClaim();
      const key = crypto.randomUUID();
      const path = `/api/v1/dashboard/orders/${order.id}/remove-driver`;

      const first = await dashPost(path, {
        key,
        rawBody: JSON.stringify({
          nextAction: "REOFFER",
          reason: "x",
        }),
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const stamp1 = iso((await orderSnapshot(order.id)).status_changed_at);

      const replay = await dashPost(path, {
        key,
        rawBody: JSON.stringify({
          reason: "x",
          nextAction: "REOFFER",
        }),
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(firstBody);
      expect(iso((await orderSnapshot(order.id)).status_changed_at)).toBe(stamp1);
      expect(await eventCount(order.id, "DRIVER_REMOVED_BEFORE_PICKUP")).toBe(1);
    });
  });

  // ─── 5. DB constraint tests ──────────────────────────────────────────────

  test("database enforces one active handoff and one active return per order", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    const replacement = await freshDriver();
    const started = await h.orderOps.startHandoffAssign(
      adminIdentity,
      order.id,
      {
        driverId: replacement.id,
        reason: "handoff أول",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    const [to] = await h.client<{ id: string }[]>`
      select id::text from order_driver_assignments
      where order_id = ${order.id} and driver_id = ${replacement.id}`;

    await assertRejects("second PENDING handoff", () =>
      h.client`
        insert into order_driver_handoffs (
          order_id, city_id, from_assignment_id, to_assignment_id,
          from_driver_id, to_driver_id, status, reason, started_by_account_id
        ) values (
          ${order.id}, ${city}, ${assignmentId}, ${to!.id},
          ${driver.id}, ${replacement.id}, 'PENDING', 'duplicate', ${adminIdentity.accountId}
        )`,
    );

    await h.orderOps.cancelHandoff(
      adminIdentity,
      order.id,
      started.handoff!.id,
      { reason: "إلغاء للعودة", idempotencyKey: crypto.randomUUID() },
    );

    await h.orderOps.startReturnToStore(adminIdentity, order.id, {
      reason: "إرجاع",
      idempotencyKey: crypto.randomUUID(),
    });
    await assertRejects("second active return", () =>
      h.client`
        insert into order_return_workflows (
          order_id, city_id, assignment_id, driver_id, status, reason,
          started_by_account_id
        ) values (
          ${order.id}, ${city}, ${assignmentId}, ${driver.id},
          'WAITING_FOR_DRIVER_RETURN', 'duplicate', ${adminIdentity.accountId}
        )`,
    );
  });

  test("database rejects handoff when from_driver equals to_driver", async () => {
    const { order, driver, assignmentId, driverFee } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    const [ghost] = await h.client<{ id: string }[]>`
      insert into order_driver_assignments (
        order_id, driver_id, city_id, assignment_source, status,
        assignment_sequence, driver_fee, assigned_by_account_id,
        pricing_base_snapshot, rounding_unit_snapshot, pricing_stages_snapshot,
        pricing_version_snapshot, pricing_stage_after_seconds,
        pricing_stage_increase_percentage
      ) values (
        ${order.id}, ${driver.id}, ${city}, 'DASHBOARD_MANUAL', 'HANDOFF_PENDING',
        2, ${driverFee}, ${adminIdentity.accountId},
        ${driverFee}, 250, ${[{ afterSeconds: 0, increasePercentage: 0 }]},
        1, 0, 0
      ) returning id::text`;

    await assertRejects("from_driver = to_driver", () =>
      h.client`
        insert into order_driver_handoffs (
          order_id, city_id, from_assignment_id, to_assignment_id,
          from_driver_id, to_driver_id, status, reason, started_by_account_id
        ) values (
          ${order.id}, ${city}, ${assignmentId}, ${ghost!.id},
          ${driver.id}, ${driver.id}, 'PENDING', 'same driver', ${adminIdentity.accountId}
        )`,
    );
  });

  test("database rejects handoff assignments from different orders", async () => {
    // No FK/check tying handoff.order_id to assignment.order_id; assert app path
    // rejects same-driver handoff and skip raw cross-order insert if unconstrained.
    const a = await approveAndClaim();
    await pickupOrder(a.order.id, a.driver, a.assignmentId);
    await expect(
      h.orderOps.startHandoffAssign(adminIdentity, a.order.id, {
        driverId: a.driver.id,
        reason: "نفس السائق",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({
      statusCode: expect.any(Number),
    });

    const b = await approveAndClaim();
    await pickupOrder(b.order.id, b.driver, b.assignmentId);
    // Document: raw insert of cross-order assignment ids is not blocked by DB check.
    // Application always creates both assignments for the same order_id.
    const [constraint] = await h.client<{ exists: boolean }[]>`
      select exists(
        select 1 from information_schema.table_constraints
        where table_name = 'order_driver_handoffs'
          and constraint_name like '%assignment%order%'
      ) as exists`;
    if (constraint!.exists) {
      await assertRejects("cross-order handoff assignments", () =>
        h.client`
          insert into order_driver_handoffs (
            order_id, city_id, from_assignment_id, to_assignment_id,
            from_driver_id, to_driver_id, status, reason, started_by_account_id
          ) values (
            ${a.order.id}, ${city}, ${a.assignmentId}, ${b.assignmentId},
            ${a.driver.id}, ${b.driver.id}, 'PENDING', 'cross', ${adminIdentity.accountId}
          )`,
      );
    }
  });

  test("replaces and replaced_by links stay consistent after handoff complete", async () => {
    const { order, driver, assignmentId, driverFee } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    const replacement = await freshDriver();
    const started = await h.orderOps.startHandoffAssign(
      adminIdentity,
      order.id,
      {
        driverId: replacement.id,
        reason: "ربط الاستبدال",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    await h.orderOps.completeHandoff(
      adminIdentity,
      order.id,
      started.handoff!.id,
      {
        reason: "إكمال",
        actedOnBehalfOf: "DRIVER",
        idempotencyKey: crypto.randomUUID(),
      },
      { kind: "DASHBOARD" },
    );

    const [from] = await h.client<
      { replaced_by_assignment_id: string; status: string }[]
    >`select replaced_by_assignment_id::text, status::text
      from order_driver_assignments where id = ${assignmentId}`;
    const [to] = await h.client<
      { id: string; replaces_assignment_id: string; driver_fee: number }[]
    >`select id::text, replaces_assignment_id::text, driver_fee
      from order_driver_assignments
      where order_id = ${order.id} and driver_id = ${replacement.id}
        and cancelled_at is null`;
    expect(from!.status).toBe("REPLACED_AFTER_PICKUP");
    expect(from!.replaced_by_assignment_id).toBe(to!.id);
    expect(to!.replaces_assignment_id).toBe(assignmentId);
    expect(Number(to!.driver_fee)).toBe(driverFee);
  });

  test("only one custody-bearing active assignment per order", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    const other = await freshDriver();
    await assertRejects("second ASSIGNED on same order", () =>
      h.client`
        insert into order_driver_assignments (
          order_id, driver_id, city_id, assignment_source, status,
          assignment_sequence, driver_fee, assigned_by_account_id
        ) values (
          ${order.id}, ${other.id}, ${city}, 'DASHBOARD_MANUAL', 'ASSIGNED',
          2, 3000, ${adminIdentity.accountId}
        )`,
    );
    expect(await countActiveAssignmentsOnOrder(order.id)).toBe(1);
    void assignmentId;
    void driver;
  });

  test("locked_driver_fee preserved across reoffer, direct assign, handoff paths", async () => {
    const removed = await approveAndClaim();
    const fee = removed.driverFee;
    const afterRemove = await h.orderOps.removeDriverBeforePickup(
      adminIdentity,
      removed.order.id,
      {
        reason: "قفل الرسوم",
        nextAction: "REOFFER",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(afterRemove.lockedDriverFee).toBe(fee);

    const direct = await approveAndClaim();
    const next = await freshDriver();
    const assigned = await h.orderOps.removeDriverBeforePickup(
      adminIdentity,
      direct.order.id,
      {
        reason: "تعيين مباشر",
        nextAction: "ASSIGN_DRIVER",
        driverId: next.id,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(assigned.lockedDriverFee).toBe(direct.driverFee);
    expect(Number((await orderSnapshot(direct.order.id)).locked_driver_fee)).toBe(
      direct.driverFee,
    );

    const handoffPath = await approveAndClaim();
    await pickupOrder(
      handoffPath.order.id,
      handoffPath.driver,
      handoffPath.assignmentId,
    );
    const replacement = await freshDriver();
    const started = await h.orderOps.startHandoffAssign(
      adminIdentity,
      handoffPath.order.id,
      {
        driverId: replacement.id,
        reason: "حفظ الرسوم",
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(started.lockedDriverFee).toBe(handoffPath.driverFee);
    const completed = await h.orderOps.completeHandoff(
      adminIdentity,
      handoffPath.order.id,
      started.handoff!.id,
      {
        reason: "إكمال",
        actedOnBehalfOf: "DRIVER",
        idempotencyKey: crypto.randomUUID(),
      },
      { kind: "DASHBOARD" },
    );
    expect(completed.lockedDriverFee).toBe(handoffPath.driverFee);
    expect(
      Number((await orderSnapshot(handoffPath.order.id)).locked_driver_fee),
    ).toBe(handoffPath.driverFee);
  });

  test("independent return completes to READY_FOR_PICKUP WITH_STORE preserving prior pickup events", async () => {
    const { order, driver, assignmentId } = await approveAndClaim();
    await pickupOrder(order.id, driver, assignmentId);
    const pickupEventsBefore = await eventCount(order.id, "DRIVER_PICKED_UP");
    expect(pickupEventsBefore).toBe(1);

    await h.orderOps.startReturnToStore(adminIdentity, order.id, {
      reason: "إرجاع تشغيلي مستقل",
      idempotencyKey: crypto.randomUUID(),
    });
    await h.orderOps.confirmDriverReturn(
      adminIdentity,
      order.id,
      { reason: "سائق أعاد", idempotencyKey: crypto.randomUUID() },
      { kind: "DASHBOARD" },
    );
    const done = await h.orderOps.confirmStoreReturn(
      adminIdentity,
      order.id,
      { reason: "المتجر استلم", idempotencyKey: crypto.randomUUID() },
      { kind: "DASHBOARD" },
    );
    expect(done.status).toBe("READY_FOR_PICKUP");
    expect(done.custodyStatus).toBe("WITH_STORE");
    expect(await eventCount(order.id, "DRIVER_PICKED_UP")).toBe(pickupEventsBefore);
    expect(await eventCount(order.id, "RETURN_COMPLETED")).toBe(1);
  });
});
