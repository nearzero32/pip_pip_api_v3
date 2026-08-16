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

describe("M4-C2 delivery cash collection", () => {
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
  let opsNoPermIdentity!: AuthIdentity;
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
      `+964773${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
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
        `collection-${id}`,
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

  const approveAndClaim = async () => {
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

  const pickupAndArrive = async (
    orderId: string,
    driver: { token: string; identity: AuthIdentity },
    assignmentId: string,
  ) => {
    await h.orderLifecycle.confirmArrivalAtStore(
      driver.identity,
      orderId,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    const pickupFile = await putReadyProof(
      driver.token,
      orderId,
      assignmentId,
      "PICKUP_PROOF",
    );
    await h.orderLifecycle.confirmPickup(
      driver.identity,
      orderId,
      { fileId: pickupFile },
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
    await h.orderLifecycle.confirmArrival(
      driver.identity,
      orderId,
      {},
      { kind: "DRIVER" },
      crypto.randomUUID(),
    );
  };

  const buildArrived = async () => {
    const ctx = await approveAndClaim();
    await pickupAndArrive(ctx.order.id, ctx.driver, ctx.assignmentId);
    const [row] = await h.client<{ total: number }[]>`
      select total from orders where id = ${ctx.order.id}`;
    return { ...ctx, expected: Number(row!.total) };
  };

  const collectionsOf = async (orderId: string) =>
    h.client<
      {
        id: string;
        assignment_id: string;
        collecting_driver_id: string;
        expected_amount: number;
        collected_amount: number;
        difference_amount: number;
        confirmation_source: string;
        confirmed_by_account_id: string;
        collected_at: Date;
      }[]
    >`select id::text, assignment_id::text, collecting_driver_id::text,
             expected_amount, collected_amount, difference_amount,
             confirmation_source::text, confirmed_by_account_id::text, collected_at
      from order_collections where order_id = ${orderId}`;

  const snapshot = async (orderId: string) => {
    const [row] = await h.client<
      {
        status: string;
        custody_status: string;
        custody_driver_id: string | null;
      }[]
    >`select status::text, custody_status::text, custody_driver_id::text
      from orders where id = ${orderId}`;
    return row!;
  };

  beforeAll(async () => {
    h = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_collection",
    });
    city = await createActiveCity(h.client, "Collection City");
    city2 = await createActiveCity(h.client, "Collection City 2");
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
    const bootstrapSuper = superIdentity;
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
        ${city}, ${cat!.id}, 'Collection Store', '+9647005555566', 'Address',
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
    await h.deliveryPricing.activate(bootstrapSuper, city, versions.data[0]!.id);
    await h.cityDriverPricing.put(
      bootstrapSuper,
      city,
      {
        pricingBase: 3000,
        roundingUnit: 250,
        pricingStages: [{ afterSeconds: 0, increasePercentage: 0 }],
      },
      "collection-driver-pricing",
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
      email: "collection-admin@example.com",
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
        email: "collection-admin@example.com",
        password: "fixed dashboard password",
        deviceName: "collection-admin",
        ip: "collection-admin",
        requestId: "collection-admin",
      })
    ).access_token;

    const opsId = await createStaffAccount(h.auth, h.client, {
      email: "collection-ops-noperm@example.com",
      password: "fixed dashboard password",
      roles: ["OPERATIONS"],
      cityId: city,
      managedByAccountId: adminId,
    });
    opsNoPermIdentity = {
      accountId: opsId,
      sessionId: null as unknown as string,
      applicationType: "DASHBOARD",
      roles: ["OPERATIONS"],
      scopeType: "CITY",
      cityId: city,
      storeId: null,
    };

    const [m] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    await h.client`
      insert into merchant_profiles(account_id, store_id, city_id, display_name, status, created_by_account_id)
      values (${m!.id}, ${store}, ${city}, 'Collection Merchant', 'ACTIVE', ${superId})`;
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

  describe("database constraints", () => {
    test("rejects collectedAmount below expected and inconsistent difference", async () => {
      const { order, driver, assignmentId } = await buildArrived();
      const [evt] = await h.client<{ id: string }[]>`
        select id::text from order_events where order_id = ${order.id} limit 1`;
      const assertRejects = async (sql: Promise<unknown>) => {
        let failed = false;
        try {
          await sql;
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
      };
      await assertRejects(h.client`
        insert into order_collections (
          order_id, assignment_id, collecting_driver_id, expected_amount,
          collected_amount, difference_amount, currency, confirmed_by_account_id,
          confirmation_source, order_event_id, collected_at
        ) values (
          ${order.id}, ${assignmentId}, ${driver.id}, 25000, 24000, 1000, 'IQD',
          ${driver.id}, 'DRIVER_APP', ${evt!.id}, now()
        )`);
      await assertRejects(h.client`
        insert into order_collections (
          order_id, assignment_id, collecting_driver_id, expected_amount,
          collected_amount, difference_amount, currency, confirmed_by_account_id,
          confirmation_source, order_event_id, collected_at
        ) values (
          ${order.id}, ${assignmentId}, ${driver.id}, 25000, 27000, 0, 'IQD',
          ${driver.id}, 'DRIVER_APP', ${evt!.id}, now()
        )`);
      await assertRejects(h.client`
        insert into order_collections (
          order_id, assignment_id, collecting_driver_id, expected_amount,
          collected_amount, difference_amount, currency, confirmed_by_account_id,
          confirmation_source, order_event_id, collected_at
        ) values (
          ${order.id}, ${assignmentId}, ${driver.id}, -1, 0, 1, 'IQD',
          ${driver.id}, 'DRIVER_APP', ${evt!.id}, now()
        )`);
      await assertRejects(h.client`
        insert into order_collections (
          order_id, assignment_id, collecting_driver_id, expected_amount,
          collected_amount, difference_amount, currency, confirmed_by_account_id,
          confirmation_source, order_event_id, collected_at
        ) values (
          ${order.id}, ${assignmentId}, ${driver.id}, 1000, 1000, 0, 'USD',
          ${driver.id}, 'DRIVER_APP', ${evt!.id}, now()
        )`);
    });

    test("one successful collection per order; assignment and driver must match", async () => {
      const a = await buildArrived();
      const b = await buildArrived();
      const fileId = await putReadyProof(
        a.driver.token,
        a.order.id,
        a.assignmentId,
        "DELIVERY_PROOF",
      );
      await h.orderLifecycle.confirmDelivery(
        a.driver.identity,
        a.order.id,
        { fileId, collectedAmount: a.expected },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      );
      const rows = await collectionsOf(a.order.id);
      expect(rows).toHaveLength(1);
      const [evt] = await h.client<{ id: string }[]>`
        select id::text from order_events where order_id = ${b.order.id} limit 1`;
      let failed = false;
      try {
        await h.client`
          insert into order_collections (
            order_id, assignment_id, collecting_driver_id, expected_amount,
            collected_amount, difference_amount, currency, confirmed_by_account_id,
            confirmation_source, order_event_id, collected_at
          ) values (
            ${a.order.id}, ${a.assignmentId}, ${a.driver.id}, ${a.expected},
            ${a.expected}, 0, 'IQD', ${a.driver.id}, 'DRIVER_APP', ${evt!.id}, now()
          )`;
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);

      failed = false;
      try {
        await h.client`
          insert into order_collections (
            order_id, assignment_id, collecting_driver_id, expected_amount,
            collected_amount, difference_amount, currency, confirmed_by_account_id,
            confirmation_source, order_event_id, collected_at
          ) values (
            ${b.order.id}, ${a.assignmentId}, ${a.driver.id}, ${b.expected},
            ${b.expected}, 0, 'IQD', ${a.driver.id}, 'DRIVER_APP', ${evt!.id}, now()
          )`;
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);

      failed = false;
      try {
        await h.client`
          insert into order_collections (
            order_id, assignment_id, collecting_driver_id, expected_amount,
            collected_amount, difference_amount, currency, confirmed_by_account_id,
            confirmation_source, order_event_id, collected_at
          ) values (
            ${b.order.id}, ${b.assignmentId}, ${a.driver.id}, ${b.expected},
            ${b.expected}, 0, 'IQD', ${a.driver.id}, 'DRIVER_APP', ${evt!.id}, now()
          )`;
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });

    test("SQL update and delete of a collection row are rejected", async () => {
      const { order, driver, assignmentId, expected } = await buildArrived();
      const fileId = await putReadyProof(
        driver.token,
        order.id,
        assignmentId,
        "DELIVERY_PROOF",
      );
      await h.orderLifecycle.confirmDelivery(
        driver.identity,
        order.id,
        { fileId, collectedAmount: expected },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      );
      let failed = false;
      try {
        await h.client`update order_collections set collected_amount = collected_amount + 1 where order_id = ${order.id}`;
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      failed = false;
      try {
        await h.client`delete from order_collections where order_id = ${order.id}`;
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(await collectionsOf(order.id)).toHaveLength(1);
    });
  });

  describe("driver app", () => {
    test("missing collectedAmount and invalid values are rejected without side effects", async () => {
      const { order, driver, assignmentId, expected } = await buildArrived();
      const fileId = await putReadyProof(
        driver.token,
        order.id,
        assignmentId,
        "DELIVERY_PROOF",
      );
      await expect(
        h.orderLifecycle.confirmDelivery(
          driver.identity,
          order.id,
          { fileId },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({ publicCode: "COLLECTED_AMOUNT_REQUIRED" });
      await expect(
        h.orderLifecycle.confirmDelivery(
          driver.identity,
          order.id,
          { fileId, collectedAmount: 12.5 },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({ publicCode: "COLLECTED_AMOUNT_INVALID" });

      const missingHttp = await h.app.handle(
        jsonRequest(`/api/v1/mobile/driver/orders/${order.id}/confirm-delivery`, {
          token: driver.token,
          body: { proofFileId: fileId },
          headers: { "idempotency-key": crypto.randomUUID() },
        }),
      );
      expect(missingHttp.status).toBe(422);

      const below = await h.app.handle(
        jsonRequest(`/api/v1/mobile/driver/orders/${order.id}/confirm-delivery`, {
          token: driver.token,
          body: { proofFileId: fileId, collectedAmount: expected - 1 },
          headers: { "idempotency-key": crypto.randomUUID() },
        }),
      );
      expect(below.status).toBe(409);
      const belowBody = await below.json();
      expect(belowBody.error.code).toBe("COLLECTED_AMOUNT_BELOW_EXPECTED");
      expect(belowBody.error.details).toEqual({
        expectedCollectionAmount: expected,
        collectedAmount: expected - 1,
        shortfallAmount: 1,
      });

      expect(await snapshot(order.id)).toMatchObject({
        status: "ARRIVED_AT_CUSTOMER",
        custody_status: "WITH_DRIVER",
        custody_driver_id: driver.id,
      });
      expect(await collectionsOf(order.id)).toHaveLength(0);
      const [assignment] = await h.client<{ status: string }[]>`
        select status::text from order_driver_assignments where id = ${assignmentId}`;
      expect(assignment!.status).toBe("ARRIVED_AT_CUSTOMER");
      const [proof] = await h.client<{ consumed_at: Date | null }[]>`
        select consumed_at from order_proofs where media_asset_id = ${fileId}`;
      expect(proof!.consumed_at).toBeNull();
      const [events] = await h.client<{ n: number }[]>`
        select count(*)::int n from order_events
        where order_id = ${order.id} and event_type = 'ORDER_DELIVERED'`;
      expect(events!.n).toBe(0);
    });

    test("equal amount records zero difference; higher amount records the surplus only", async () => {
      const equal = await buildArrived();
      const equalFile = await putReadyProof(
        equal.driver.token,
        equal.order.id,
        equal.assignmentId,
        "DELIVERY_PROOF",
      );
      const equalRes = await h.orderLifecycle.confirmDelivery(
        equal.driver.identity,
        equal.order.id,
        { fileId: equalFile, collectedAmount: equal.expected },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      );
      expect(equalRes).toMatchObject({
        status: "DELIVERED",
        custodyStatus: "WITH_CUSTOMER",
        collection: {
          expectedAmount: equal.expected,
          collectedAmount: equal.expected,
          differenceAmount: 0,
          currency: "IQD",
          assignmentId: equal.assignmentId,
          collectingDriverId: equal.driver.id,
          confirmationSource: "DRIVER_APP",
        },
      });
      const [wallets] = await h.client<{ n: number }[]>`
        select count(*)::int n from information_schema.tables
        where table_schema = 'public' and table_name in ('wallets','ledger_entries','tips','payouts')`;
      expect(wallets!.n).toBe(0);

      const over = await buildArrived();
      const overFile = await putReadyProof(
        over.driver.token,
        over.order.id,
        over.assignmentId,
        "DELIVERY_PROOF",
      );
      const delivered = await h.orderLifecycle.confirmDelivery(
        over.driver.identity,
        over.order.id,
        { fileId: overFile, collectedAmount: over.expected + 2000 },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      );
      expect(delivered.collection.differenceAmount).toBe(2000);
      expect(delivered.collection.collectedAmount).toBe(over.expected + 2000);
    });

    test("proof remains required; non-custody driver is rejected", async () => {
      const { order, driver, assignmentId, expected } = await buildArrived();
      await expect(
        h.orderLifecycle.confirmDelivery(
          driver.identity,
          order.id,
          { collectedAmount: expected },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({ publicCode: "PROOF_REQUIRED" });
      const other = await freshDriver();
      const fileId = await putReadyProof(
        driver.token,
        order.id,
        assignmentId,
        "DELIVERY_PROOF",
      );
      await expect(
        h.orderLifecycle.confirmDelivery(
          other.identity,
          order.id,
          { fileId, collectedAmount: expected },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({
        publicCode: expect.stringMatching(/DRIVER_|ASSIGNMENT/),
      });
      expect(await collectionsOf(order.id)).toHaveLength(0);
    });

    test("active assignment exposes expectedCollectionAmount before delivery", async () => {
      const { order, driver, expected } = await buildArrived();
      const task = await h.orderLifecycle.getDriverActiveAssignment(driver.identity);
      expect(task.order.id).toBe(order.id);
      expect(task.order.expectedCollectionAmount).toBe(expected);
      expect(task.order.currency).toBe("IQD");
      expect(task.order.total).toBe(expected);
    });
  });

  describe("handoff attribution", () => {
    test("collection is attributed to the final custody assignment after handoff", async () => {
      const { order, driver, assignmentId, expected } = await buildArrived();
      const replacement = await freshDriver();
      const started = await h.orderOps.startHandoffAssign(adminIdentity, order.id, {
        driverId: replacement.id,
        reason: "نقل للتحصيل",
        idempotencyKey: crypto.randomUUID(),
      });
      await expect(
        h.orderLifecycle.confirmDelivery(
          driver.identity,
          order.id,
          { collectedAmount: expected, fileId: crypto.randomUUID() },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({ publicCode: "DRIVER_HANDOFF_ALREADY_ACTIVE" });

      await h.orderOps.completeHandoff(
        adminIdentity,
        order.id,
        started.handoff!.id,
        {
          reason: "إكمال النقل",
          actedOnBehalfOf: "DRIVER",
          idempotencyKey: crypto.randomUUID(),
        },
        { kind: "DASHBOARD" },
      );
      const [toAssignment] = await h.client<{ id: string }[]>`
        select id::text from order_driver_assignments
        where order_id = ${order.id} and driver_id = ${replacement.id}
          and cancelled_at is null`;
      await h.orderLifecycle.confirmArrival(
        replacement.identity,
        order.id,
        {},
        { kind: "DRIVER" },
        crypto.randomUUID(),
      );
      const fileId = await putReadyProof(
        replacement.token,
        order.id,
        toAssignment!.id,
        "DELIVERY_PROOF",
      );
      const delivered = await h.orderLifecycle.confirmDelivery(
        replacement.identity,
        order.id,
        { fileId, collectedAmount: expected },
        { kind: "DRIVER" },
        crypto.randomUUID(),
      );
      expect(delivered.collection.assignmentId).toBe(toAssignment!.id);
      expect(delivered.collection.collectingDriverId).toBe(replacement.id);
      expect(delivered.collection.assignmentId).not.toBe(assignmentId);
      const rows = await collectionsOf(order.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.collecting_driver_id).toBe(replacement.id);
      expect(rows[0]!.assignment_id).toBe(toAssignment!.id);
    });
  });

  describe("dashboard override", () => {
    test("requires collectedAmount and reason; proof is not required", async () => {
      const { order, expected } = await buildArrived();
      const missingAmount = await h.app.handle(
        jsonRequest(`/api/v1/dashboard/orders/${order.id}/confirm-delivery`, {
          token: adminToken,
          body: { reason: "تسليم إداري" },
          headers: { "idempotency-key": crypto.randomUUID() },
        }),
      );
      expect(missingAmount.status).toBe(422);
      const missingReason = await h.app.handle(
        jsonRequest(`/api/v1/dashboard/orders/${order.id}/confirm-delivery`, {
          token: adminToken,
          body: { collectedAmount: expected },
          headers: { "idempotency-key": crypto.randomUUID() },
        }),
      );
      expect(missingReason.status).toBe(422);
      const below = await h.app.handle(
        jsonRequest(`/api/v1/dashboard/orders/${order.id}/confirm-delivery`, {
          token: adminToken,
          body: {
            collectedAmount: expected - 1,
            reason: "أقل",
          },
          headers: { "idempotency-key": crypto.randomUUID() },
        }),
      );
      expect(below.status).toBe(409);
      expect((await below.json()).error.code).toBe("COLLECTED_AMOUNT_BELOW_EXPECTED");

      const ok = await h.app.handle(
        jsonRequest(`/api/v1/dashboard/orders/${order.id}/confirm-delivery`, {
          token: adminToken,
          body: { collectedAmount: expected + 500, reason: "تسليم إداري" },
          headers: { "idempotency-key": crypto.randomUUID() },
        }),
      );
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.collection).toMatchObject({
        expectedAmount: expected,
        collectedAmount: expected + 500,
        differenceAmount: 500,
        confirmationSource: "DASHBOARD_OVERRIDE",
        collectingDriverId: body.assignment.driverId,
      });
      const [row] = await collectionsOf(order.id);
      expect(row!.confirmed_by_account_id).toBe(adminIdentity.accountId);
      expect(row!.collecting_driver_id).not.toBe(adminIdentity.accountId);
    });

    test("SUPER_ADMIN and unpermissioned employee are blocked; cross-city is 404", async () => {
      const { order, expected } = await buildArrived();
      await expect(
        h.orderLifecycle.confirmDelivery(
          superIdentity,
          order.id,
          { collectedAmount: expected, reason: "ممنوع" },
          { kind: "DASHBOARD", reason: "ممنوع", actedOnBehalfOf: "DRIVER" },
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });
      await expect(
        h.orderLifecycle.confirmDelivery(
          opsNoPermIdentity,
          order.id,
          { collectedAmount: expected, reason: "بلا صلاحية" },
          { kind: "DASHBOARD", reason: "بلا صلاحية", actedOnBehalfOf: "DRIVER" },
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({ publicCode: expect.stringMatching(/FORBIDDEN|PERMISSION/) });

      const otherAdminId = await createStaffAccount(h.auth, h.client, {
        email: `collection-city2-${crypto.randomUUID()}@example.com`,
        password: "fixed dashboard password",
        roles: ["ADMIN"],
        cityId: city2,
      });
      const otherIdentity: AuthIdentity = {
        accountId: otherAdminId,
        sessionId: null as unknown as string,
        applicationType: "DASHBOARD",
        roles: ["ADMIN"],
        scopeType: "CITY",
        cityId: city2,
        storeId: null,
      };
      await expect(
        h.orderLifecycle.confirmDelivery(
          otherIdentity,
          order.id,
          { collectedAmount: expected, reason: "مدينة أخرى" },
          { kind: "DASHBOARD", reason: "مدينة أخرى", actedOnBehalfOf: "DRIVER" },
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({ publicCode: "ORDER_NOT_FOUND", statusCode: 404 });
    });
  });

  describe("idempotency and races", () => {
    test("driver replay keeps one collection and stable timestamps", async () => {
      const { order, driver, assignmentId, expected } = await buildArrived();
      const fileId = await putReadyProof(
        driver.token,
        order.id,
        assignmentId,
        "DELIVERY_PROOF",
      );
      const key = crypto.randomUUID();
      const first = await h.orderLifecycle.confirmDelivery(
        driver.identity,
        order.id,
        { fileId, collectedAmount: expected },
        { kind: "DRIVER" },
        key,
      );
      const stamp = first.deliveredAt;
      const replay = await h.orderLifecycle.confirmDelivery(
        driver.identity,
        order.id,
        { fileId, collectedAmount: expected },
        { kind: "DRIVER" },
        key,
      );
      expect(replay).toEqual(first);
      expect(replay.deliveredAt).toBe(stamp);
      expect(await collectionsOf(order.id)).toHaveLength(1);
      const [events] = await h.client<{ n: number }[]>`
        select count(*)::int n from order_events
        where order_id = ${order.id} and event_type = 'ORDER_DELIVERED'`;
      expect(events!.n).toBe(1);

      await expect(
        h.orderLifecycle.confirmDelivery(
          driver.identity,
          order.id,
          { fileId, collectedAmount: expected + 1 },
          { kind: "DRIVER" },
          key,
        ),
      ).rejects.toMatchObject({ publicCode: "IDEMPOTENCY_KEY_REUSED" });
      await expect(
        h.orderLifecycle.confirmDelivery(
          driver.identity,
          order.id,
          { fileId: crypto.randomUUID(), collectedAmount: expected },
          { kind: "DRIVER" },
          key,
        ),
      ).rejects.toMatchObject({ publicCode: "IDEMPOTENCY_KEY_REUSED" });
    });

    test("dashboard replay and conflict", async () => {
      const { order, expected } = await buildArrived();
      const key = crypto.randomUUID();
      const first = await h.orderLifecycle.confirmDelivery(
        adminIdentity,
        order.id,
        { collectedAmount: expected, reason: "إداري" },
        { kind: "DASHBOARD", reason: "إداري", actedOnBehalfOf: "DRIVER" },
        key,
      );
      const replay = await h.orderLifecycle.confirmDelivery(
        adminIdentity,
        order.id,
        { collectedAmount: expected, reason: "إداري" },
        { kind: "DASHBOARD", reason: "إداري", actedOnBehalfOf: "DRIVER" },
        key,
      );
      expect(replay).toEqual(first);
      expect(await collectionsOf(order.id)).toHaveLength(1);
      await expect(
        h.orderLifecycle.confirmDelivery(
          adminIdentity,
          order.id,
          { collectedAmount: expected + 1, reason: "إداري" },
          { kind: "DASHBOARD", reason: "إداري", actedOnBehalfOf: "DRIVER" },
          key,
        ),
      ).rejects.toMatchObject({ publicCode: "IDEMPOTENCY_KEY_REUSED" });
      await expect(
        h.orderLifecycle.confirmDelivery(
          adminIdentity,
          order.id,
          { collectedAmount: expected, reason: "سبب مختلف" },
          { kind: "DASHBOARD", reason: "سبب مختلف", actedOnBehalfOf: "DRIVER" },
          key,
        ),
      ).rejects.toMatchObject({ publicCode: "IDEMPOTENCY_KEY_REUSED" });
    });

    test("concurrent driver deliveries produce one collection", async () => {
      const { order, driver, assignmentId, expected } = await buildArrived();
      const fileId = await putReadyProof(
        driver.token,
        order.id,
        assignmentId,
        "DELIVERY_PROOF",
      );
      const results = await Promise.allSettled([
        h.orderLifecycle.confirmDelivery(
          driver.identity,
          order.id,
          { fileId, collectedAmount: expected },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        ),
        h.orderLifecycle.confirmDelivery(
          driver.identity,
          order.id,
          { fileId, collectedAmount: expected },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      expect(await collectionsOf(order.id)).toHaveLength(1);
      const [events] = await h.client<{ n: number }[]>`
        select count(*)::int n from order_events
        where order_id = ${order.id} and event_type = 'ORDER_DELIVERED'`;
      expect(events!.n).toBe(1);
    });

    test("driver × dashboard delivery yields one winner and one collection", async () => {
      const { order, driver, assignmentId, expected } = await buildArrived();
      const fileId = await putReadyProof(
        driver.token,
        order.id,
        assignmentId,
        "DELIVERY_PROOF",
      );
      const results = await Promise.allSettled([
        h.orderLifecycle.confirmDelivery(
          driver.identity,
          order.id,
          { fileId, collectedAmount: expected },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        ),
        h.orderLifecycle.confirmDelivery(
          adminIdentity,
          order.id,
          { collectedAmount: expected + 1000, reason: "متزامن" },
          { kind: "DASHBOARD", reason: "متزامن", actedOnBehalfOf: "DRIVER" },
          crypto.randomUUID(),
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      const rows = await collectionsOf(order.id);
      expect(rows).toHaveLength(1);
      expect(await snapshot(order.id)).toMatchObject({
        status: "DELIVERED",
        custody_status: "WITH_CUSTOMER",
      });
      if (rows[0]!.confirmation_source === "DASHBOARD_OVERRIDE") {
        const [proof] = await h.client<{ consumed_at: Date | null }[]>`
          select consumed_at from order_proofs where media_asset_id = ${fileId}`;
        expect(proof!.consumed_at).toBeNull();
      }
    });

    test("cancel × delivery is atomic: collection only if delivery wins", async () => {
      const { order, driver, assignmentId, expected } = await buildArrived();
      const fileId = await putReadyProof(
        driver.token,
        order.id,
        assignmentId,
        "DELIVERY_PROOF",
      );
      const results = await Promise.allSettled([
        h.orderOps.cancelByDashboard(adminIdentity, order.id, {
          reason: "إلغاء مع التحصيل",
          idempotencyKey: crypto.randomUUID(),
        }),
        h.orderLifecycle.confirmDelivery(
          driver.identity,
          order.id,
          { fileId, collectedAmount: expected },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      const snap = await snapshot(order.id);
      const rows = await collectionsOf(order.id);
      if (snap.status === "DELIVERED") {
        expect(rows).toHaveLength(1);
        expect(snap.custody_status).toBe("WITH_CUSTOMER");
      } else {
        expect(snap.status).toBe("CANCELLED");
        expect(rows).toHaveLength(0);
        expect(snap.custody_status).toBe("WITH_DRIVER");
      }
    });

    test("claimAsset failure and pre-inserted collection roll back delivery", async () => {
      const pending = await buildArrived();
      const intentRes = await h.app.handle(
        jsonRequest(
          `/api/v1/mobile/driver/orders/${pending.order.id}/proofs/upload-intent`,
          {
            token: pending.driver.token,
            body: {
              assignmentId: pending.assignmentId,
              purpose: "DELIVERY_PROOF",
              contentType: "image/png",
              fileName: "pending.png",
              sizeBytes: PNG.length,
            },
          },
        ),
      );
      const { fileId } = (await intentRes.json()) as { fileId: string };
      await expect(
        h.orderLifecycle.confirmDelivery(
          pending.driver.identity,
          pending.order.id,
          { fileId, collectedAmount: pending.expected },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({ publicCode: "MEDIA_NOT_ATTACHABLE" });
      expect(await snapshot(pending.order.id)).toMatchObject({
        status: "ARRIVED_AT_CUSTOMER",
        custody_status: "WITH_DRIVER",
      });
      expect(await collectionsOf(pending.order.id)).toHaveLength(0);

      const blocked = await buildArrived();
      const [evt] = await h.client<{ id: string }[]>`
        select id::text from order_events where order_id = ${blocked.order.id} limit 1`;
      await h.client`
        insert into order_collections (
          order_id, assignment_id, collecting_driver_id, expected_amount,
          collected_amount, difference_amount, currency, confirmed_by_account_id,
          confirmation_source, order_event_id, collected_at
        ) values (
          ${blocked.order.id}, ${blocked.assignmentId}, ${blocked.driver.id},
          ${blocked.expected}, ${blocked.expected}, 0, 'IQD', ${blocked.driver.id},
          'DRIVER_APP', ${evt!.id}, now()
        )`;
      const readyFile = await putReadyProof(
        blocked.driver.token,
        blocked.order.id,
        blocked.assignmentId,
        "DELIVERY_PROOF",
      );
      await expect(
        h.orderLifecycle.confirmDelivery(
          blocked.driver.identity,
          blocked.order.id,
          { fileId: readyFile, collectedAmount: blocked.expected },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({
        publicCode: expect.stringMatching(/ORDER_COLLECTION_ALREADY_RECORDED|23505|COLLECTION/),
      });
      expect(await snapshot(blocked.order.id)).toMatchObject({
        status: "ARRIVED_AT_CUSTOMER",
      });
    });

    test("Redis failure after commit does not undo collection", async () => {
      const { order, driver, assignmentId, expected } = await buildArrived();
      const fileId = await putReadyProof(
        driver.token,
        order.id,
        assignmentId,
        "DELIVERY_PROOF",
      );
      const original = h.driverRuntime.setRuntime.bind(h.driverRuntime);
      h.driverRuntime.setRuntime = async () => {
        throw new Error("redis unavailable");
      };
      try {
        const delivered = await h.orderLifecycle.confirmDelivery(
          driver.identity,
          order.id,
          { fileId, collectedAmount: expected },
          { kind: "DRIVER" },
          crypto.randomUUID(),
        );
        expect(delivered.status).toBe("DELIVERED");
        expect(await collectionsOf(order.id)).toHaveLength(1);
      } finally {
        h.driverRuntime.setRuntime = original;
      }
    });
  });

  test("OpenAPI documents collectedAmount and has no under-collection flags", async () => {
    const doc = (await (
      await h.app.handle(new Request("http://localhost/openapi/json"))
    ).json()) as { paths: Record<string, any> };
    const driver = doc.paths["/api/v1/mobile/driver/orders/{orderId}/confirm-delivery"].post;
    const dash = doc.paths["/api/v1/dashboard/orders/{orderId}/confirm-delivery"].post;
    expect(JSON.stringify(driver.requestBody)).toContain("collectedAmount");
    expect(JSON.stringify(driver.requestBody)).toContain("proofFileId");
    expect(JSON.stringify(dash.requestBody)).toContain("collectedAmount");
    expect(JSON.stringify(dash.requestBody)).toContain("reason");
    const blob = JSON.stringify(doc);
      const driverSchema = JSON.stringify(driver.requestBody);
      const dashSchema = JSON.stringify(dash.requestBody);
      expect(driverSchema).not.toContain("allowUnder");
      expect(dashSchema).not.toContain("allowUnder");
      expect(dashSchema).not.toContain("forceAmount");
      expect(dashSchema).not.toContain("skipCollection");
    expect(doc.paths["/api/v1/dashboard/orders/{orderId}/collection"]).toBeUndefined();
  });
});
