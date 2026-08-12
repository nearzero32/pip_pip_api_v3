// @ts-nocheck
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AuthIdentity } from "../../src/modules/auth/sessions/session-service";
import { customerContext } from "../../src/modules/auth/core/context";
import { AppError } from "../../src/errors/app-error";
import {
  createActiveCity,
  createDriverAccount,
  createIntegrationHarness,
  createStaffAccount,
  type IntegrationHarness,
} from "./helpers";

const deliveryPricingInput = {
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

const driverPricingInput = {
  pricingBase: 1000,
  roundingUnit: 250,
  pricingStages: [
    { afterSeconds: 0, increasePercentage: 0 },
    { afterSeconds: 30, increasePercentage: 20 },
    { afterSeconds: 60, increasePercentage: 50 },
    { afterSeconds: 90, increasePercentage: 100 },
  ],
};

describe("M4-B Driver Offers", () => {
  let h: IntegrationHarness;
  let city = "";
  let otherCity = "";
  let store = "";
  let product = "";
  let customer = "";
  let addressId = "";
  let adminId = "";
  let adminIdentity!: AuthIdentity;
  let superIdentity!: AuthIdentity;
  let superId = "";

  const driverIdentity = (accountId: string, cityId: string): AuthIdentity => ({
    accountId,
    sessionId: null as unknown as string,
    applicationType: "DRIVER_APP",
    roles: [],
    scopeType: null,
    cityId,
    storeId: null,
  });

  const approveAndOpen = async (orderId: string) => {
    await h.orders.approve(
      adminIdentity, orderId, { kind: "DASHBOARD" }, crypto.randomUUID(),
    );
    const rounds = await h.offers.listRounds(adminIdentity, orderId);
    return rounds[0]!;
  };

  const createEligibleDriver = async (cityId = city) => {
    return createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      cityId,
    );
  };

  const createApprovedSearchingOrder = async () => {
    const order = await h.orders.create(customer, city, {
      storeId: store,
      addressId,
      paymentMethod: "CASH",
      items: [{ productId: product, quantity: 1 }],
      idempotencyKey: crypto.randomUUID(),
    });
    const round = await approveAndOpen(order.id);
    return { order, round };
  };

  /** Drivers no longer need an availability transition before spin/claim. */
  const createOnlineDriver = createEligibleDriver;

  beforeAll(async () => {
    h = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_offers" });
    city = await createActiveCity(h.client, "Offers City");
    otherCity = await createActiveCity(h.client, "Offers Other City");

    const [actor] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
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
        ${city}, ${cat!.id}, 'Offer Store', '+9647001111199', 'Address',
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
      values (${store}, ${city}, 'منتج', 2000, true, 'ACTIVE', ${superId}) returning id`;
    product = p!.id;

    await h.deliveryPricing.create(superIdentity, city, deliveryPricingInput);
    const versions = await h.deliveryPricing.list(superIdentity, city);
    await h.deliveryPricing.activate(superIdentity, city, versions[0]!.id);
    h.routingProvider.setResult({ distanceMeters: 1000, durationSeconds: 120 });

    await h.cityDriverPricing.put(superIdentity, city, driverPricingInput, "pricing", crypto.randomUUID());

    const [c] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    customer = c!.id;
    await h.client`insert into customer_profiles(account_id) values (${customer})`;
    const addr = await h.addresses.create(customer, city, {
      label: "البيت",
      location: { latitude: 33.31, longitude: 44.41 },
      addressDetails: "تفاصيل",
    });
    addressId = addr.id;

    adminId = await createStaffAccount(h.auth, h.client, {
      email: "offers-admin@example.com",
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
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  test("spin returns at most 5 city offers with fee only", async () => {
    const driverId = await createOnlineDriver();
    for (let i = 0; i < 6; i++) {
      await createApprovedSearchingOrder();
      await Bun.sleep(5);
    }
    const cards = await h.offers.spin(driverIdentity(driverId, city));
    expect(cards.length).toBe(5);
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual(["offerId", "offeredDriverFee"]);
      expect(card.offeredDriverFee).toBe(1000);
    }
  });

  test("driver with active assignment cannot spin; successful claim returns orderTotal and paymentMethod", async () => {
    const driverId = await createEligibleDriver();
    const { round } = await createApprovedSearchingOrder();
    const claimed = await h.offers.claim(
      driverIdentity(driverId, city),
      round.id,
      crypto.randomUUID(),
      "claim-1",
    );
    expect(claimed.orderId).toBeTruthy();
    expect(claimed.paymentMethod).toBe("CASH");
    expect(claimed.orderTotal).toBeGreaterThan(claimed.offeredDriverFee);
    expect(claimed.store?.name).toBe("Offer Store");

    await expect(
      h.offers.spin(driverIdentity(driverId, city)),
    ).rejects.toMatchObject({ publicCode: "DRIVER_ACTIVE_ORDER_EXISTS" });
  });

  test("two drivers race one offer — exactly one winner", async () => {
    const d1 = await createOnlineDriver();
    const d2 = await createOnlineDriver();
    const { round } = await createApprovedSearchingOrder();
    const results = await Promise.allSettled([
      h.offers.claim(driverIdentity(d1, city), round.id, crypto.randomUUID(), "r1"),
      h.offers.claim(driverIdentity(d2, city), round.id, crypto.randomUUID(), "r2"),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(1);
    const err = (losses[0] as PromiseRejectedResult).reason as AppError;
    expect(["OFFER_NOT_OPEN", "ORDER_ALREADY_ASSIGNED"]).toContain(err.publicCode);

    const [assignments] = await h.client<{ count: number }[]>`
      select count(*)::int as count from order_driver_assignments
      where offer_round_id = ${round.id} and cancelled_at is null and completed_at is null`;
    expect(assignments!.count).toBe(1);
  });

  test("one driver cannot self-claim two active orders", async () => {
    const driverId = await createOnlineDriver();
    const a = await createApprovedSearchingOrder();
    const b = await createApprovedSearchingOrder();
    const results = await Promise.allSettled([
      h.offers.claim(driverIdentity(driverId, city), a.round.id, crypto.randomUUID(), "a"),
      h.offers.claim(driverIdentity(driverId, city), b.round.id, crypto.randomUUID(), "b"),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled");
    expect(wins.length).toBe(1);
    const [active] = await h.client<{ count: number }[]>`
      select count(*)::int as count from order_driver_assignments
      where driver_id = ${driverId} and completed_at is null and cancelled_at is null`;
    expect(active!.count).toBe(1);
  });

  test("manual second assignment allowed; third rejected; SUPER_ADMIN blocked", async () => {
    const driverId = await createOnlineDriver();
    const first = await createApprovedSearchingOrder();
    await h.offers.claim(
      driverIdentity(driverId, city),
      first.round.id,
      crypto.randomUUID(),
      "m1",
    );
    const second = await createApprovedSearchingOrder();
    const assigned = await h.offers.assignDriver(
      adminIdentity,
      second.order.id,
      { driverId, reason: "PEAK_DEMAND" },
      crypto.randomUUID(),
      "assign-2",
    );
    expect(assigned.assignmentSequence).toBe(2);

    const third = await createApprovedSearchingOrder();
    await expect(
      h.offers.assignDriver(
        adminIdentity,
        third.order.id,
        { driverId, reason: "PEAK_DEMAND" },
        crypto.randomUUID(),
        "assign-3",
      ),
    ).rejects.toMatchObject({ publicCode: "DRIVER_ASSIGNMENT_CAPACITY_REACHED" });

    await expect(
      h.offers.assignDriver(
        superIdentity,
        third.order.id,
        { driverId, reason: "PEAK_DEMAND" },
        crypto.randomUUID(),
        "assign-sa",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("claim vs manual assignment — exactly one winner", async () => {
    const driverId = await createOnlineDriver();
    const otherDriver = await createOnlineDriver();
    const { order, round } = await createApprovedSearchingOrder();
    const results = await Promise.allSettled([
      h.offers.claim(
        driverIdentity(driverId, city),
        round.id,
        crypto.randomUUID(),
        "cv",
      ),
      h.offers.assignDriver(
        adminIdentity,
        order.id,
        { driverId: otherDriver, reason: "PEAK_DEMAND" },
        crypto.randomUUID(),
        "mv",
      ),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled");
    expect(wins.length).toBe(1);
    const [count] = await h.client<{ count: number }[]>`
      select count(*)::int as count from order_driver_assignments
      where order_id = ${order.id} and completed_at is null and cancelled_at is null`;
    expect(count!.count).toBe(1);
  });

  test("cross-city claim is hidden as not found; pricing snapshot survives city price change", async () => {
    const localDriver = await createOnlineDriver();
    const foreignDriver = await createOnlineDriver(otherCity);
    const { round } = await createApprovedSearchingOrder();
    await expect(
      h.offers.claim(
        driverIdentity(foreignDriver, otherCity),
        round.id,
        crypto.randomUUID(),
        "xc",
      ),
    ).rejects.toMatchObject({ publicCode: "OFFER_NOT_FOUND" });

    await h.cityDriverPricing.put(
      superIdentity,
      city,
      {
        pricingBase: 5000,
        roundingUnit: 250,
        pricingStages: [{ afterSeconds: 0, increasePercentage: 0 }],
      },
      "pricing2",
      crypto.randomUUID(),
    );
    const claimed = await h.offers.claim(
      driverIdentity(localDriver, city),
      round.id,
      crypto.randomUUID(),
      "snap",
    );
    expect(claimed.offeredDriverFee).toBe(1000);
    await h.cityDriverPricing.put(
      superIdentity,
      city,
      driverPricingInput,
      "pricing-restore",
      crypto.randomUUID(),
    );
  });

  test("idempotent claim retry does not duplicate assignment", async () => {
    const driverId = await createOnlineDriver();
    const { round } = await createApprovedSearchingOrder();
    const key = crypto.randomUUID();
    const first = await h.offers.claim(
      driverIdentity(driverId, city),
      round.id,
      key,
      "id1",
    );
    const second = await h.offers.claim(
      driverIdentity(driverId, city),
      round.id,
      key,
      "id2",
    );
    expect(second.orderId).toBe(first.orderId);
    const [count] = await h.client<{ count: number }[]>`
      select count(*)::int as count from order_driver_assignments
      where driver_id = ${driverId} and completed_at is null and cancelled_at is null`;
    expect(count!.count).toBe(1);
  });

  test("stale redis open offer cannot be claimed after stop", async () => {
    const driverId = await createOnlineDriver();
    const { order, round } = await createApprovedSearchingOrder();
    await h.offers.stopRound(
      adminIdentity,
      order.id,
      "PAUSE",
      "stop",
      crypto.randomUUID(),
    );
    await h.driverRuntime.publishOpenOffer({
      offerId: round.id,
      orderId: order.id,
      cityId: city,
      openedAt: new Date().toISOString(),
      pricingBaseSnapshot: 1000,
      roundingUnitSnapshot: 250,
      pricingStagesSnapshot: driverPricingInput.pricingStages,
      pricingVersionSnapshot: 1,
    });
    const cards = await h.offers.spin(driverIdentity(driverId, city));
    const stale = cards.find((c) => c.offerId === round.id);
    if (stale) {
      await expect(
        h.offers.claim(
          driverIdentity(driverId, city),
          round.id,
          crypto.randomUUID(),
          "stale",
        ),
      ).rejects.toMatchObject({ publicCode: "OFFER_NOT_OPEN" });
    }
  });

  test("cancel closes assignment and frees capacity; second task keeps BUSY", async () => {
    const driverId = await createOnlineDriver();
    const first = await createApprovedSearchingOrder();
    await h.offers.claim(
      driverIdentity(driverId, city),
      first.round.id,
      crypto.randomUUID(),
      "c1",
    );
    const second = await createApprovedSearchingOrder();
    await h.offers.assignDriver(
      adminIdentity,
      second.order.id,
      { driverId, reason: "PEAK" },
      crypto.randomUUID(),
      "c2",
    );
    await h.orders.cancelByDashboard(adminIdentity, first.order.id, "cancel one");
    const [active] = await h.client<{ count: number }[]>`
      select count(*)::int as count from order_driver_assignments
      where driver_id = ${driverId} and completed_at is null and cancelled_at is null`;
    expect(active!.count).toBe(1);
    const runtime = await h.driverRuntime.getRuntime(driverId);
    expect(runtime?.workStatus).toBe("BUSY");
    expect(runtime?.activeOrderCount).toBe(1);

    await h.orders.cancelByDashboard(adminIdentity, second.order.id, "cancel two");
    const [active2] = await h.client<{ count: number }[]>`
      select count(*)::int as count from order_driver_assignments
      where driver_id = ${driverId} and completed_at is null and cancelled_at is null`;
    expect(active2!.count).toBe(0);
  });

  test("cancel last task does not promote OFFLINE to AVAILABLE", async () => {
    const driverId = await createEligibleDriver();
    // Force BUSY via manual assign
    const order = await createApprovedSearchingOrder();
    await h.offers.assignDriver(
      adminIdentity,
      order.order.id,
      { driverId, reason: "PEAK" },
      crypto.randomUUID(),
      "off1",
    );
    const [revRow] = await h.client<{ revision: number }[]>`
      select revision from driver_runtime_revisions where driver_id = ${driverId}`;
    await h.driverRuntime.setRuntime({
      driverId,
      cityId: city,
      eligibilityStatus: "ELIGIBLE",
      workStatus: "OFFLINE",
      activeOrderCount: 1,
      eligibilityVersion: 1,
      revision: Number(revRow!.revision),
      updatedAt: new Date().toISOString(),
    });
    await h.orders.cancelByDashboard(adminIdentity, order.order.id, "done");
    const runtime = await h.driverRuntime.getRuntime(driverId);
    expect(runtime?.workStatus).toBe("OFFLINE");
    expect(runtime?.activeOrderCount).toBe(0);
  });

  test("cache miss hydrate stays OFFLINE but spin still works without availability transition", async () => {
    const driverId = await createEligibleDriver();
    await createApprovedSearchingOrder();
    await h.driverRuntime.invalidateRuntime(driverId);
    const hydrated = await h.driverRuntime.getOrHydrateRuntime(driverId, async () => {
      const { hydrateDriverRuntimeFromPostgres } = await import(
        "../../src/modules/driver-offers/driver-runtime"
      );
      return (await hydrateDriverRuntimeFromPostgres(h.client, driverId))!;
    });
    expect(hydrated.workStatus).toBe("OFFLINE");
    const cards = await h.offers.spin(driverIdentity(driverId, city));
    expect(cards.length).toBeGreaterThan(0);
  });

  test("OFFLINE and AVAILABLE runtime both allow spin; missing key does not block", async () => {
    const offlineDriver = await createEligibleDriver();
    const availableDriver = await createEligibleDriver();
    const missingKeyDriver = await createEligibleDriver();
    await createApprovedSearchingOrder();

    await h.driverRuntime.setRuntime({
      driverId: offlineDriver,
      cityId: city,
      eligibilityStatus: "ELIGIBLE",
      workStatus: "OFFLINE",
      activeOrderCount: 0,
      eligibilityVersion: 1,
      updatedAt: new Date().toISOString(),
    });
    await h.driverRuntime.setRuntime({
      driverId: availableDriver,
      cityId: city,
      eligibilityStatus: "ELIGIBLE",
      workStatus: "AVAILABLE",
      activeOrderCount: 0,
      eligibilityVersion: 1,
      updatedAt: new Date().toISOString(),
    });
    await h.driverRuntime.invalidateRuntime(missingKeyDriver);

    const a = await h.offers.spin(driverIdentity(offlineDriver, city));
    const b = await h.offers.spin(driverIdentity(availableDriver, city));
    const c = await h.offers.spin(driverIdentity(missingKeyDriver, city));
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(c.length).toBeGreaterThan(0);
  });

  test("OFFLINE driver can claim when eligible with no active assignment", async () => {
    const driverId = await createEligibleDriver();
    const { round } = await createApprovedSearchingOrder();
    await h.driverRuntime.setRuntime({
      driverId,
      cityId: city,
      eligibilityStatus: "ELIGIBLE",
      workStatus: "OFFLINE",
      activeOrderCount: 0,
      eligibilityVersion: 1,
      updatedAt: new Date().toISOString(),
    });
    const claimed = await h.offers.claim(
      driverIdentity(driverId, city),
      round.id,
      crypto.randomUUID(),
      "offline-claim",
    );
    expect(claimed.orderId).toBeTruthy();
  });

  test("availability endpoint is not registered and absent from OpenAPI", async () => {
    const response = await h.app.handle(
      new Request("http://localhost/openapi/json"),
    );
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      paths: Record<string, unknown>;
    };
    expect(
      document.paths["/api/v1/mobile/driver/runtime/availability"],
    ).toBeUndefined();

    const post = await h.app.handle(
      new Request("http://localhost/api/v1/mobile/driver/runtime/availability", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workStatus: "AVAILABLE" }),
      }),
    );
    expect(post.status).toBe(404);
  });

  test("manual assign without round stores historical pricing snapshot", async () => {
    const driverId = await createOnlineDriver();
    const order = await h.orders.create(customer, city, {
      storeId: store,
      addressId,
      paymentMethod: "CASH",
      items: [{ productId: product, quantity: 1 }],
      idempotencyKey: crypto.randomUUID(),
    });
    await h.orders.approve(
      adminIdentity, order.id, { kind: "DASHBOARD" }, crypto.randomUUID(),
    );
    // Approval opens the round; stop it before direct assignment.
    await h.offers.stopRound(adminIdentity, order.id, "pause", "s", crypto.randomUUID());
    // Need SEARCHING_DRIVER still — stop doesn't change order status
    const assigned = await h.offers.assignDriver(
      adminIdentity,
      order.id,
      { driverId, reason: "DIRECT" },
      crypto.randomUUID(),
      "direct",
    );
    expect(assigned.offerRoundId).toBeNull();
    const [row] = await h.client<Record<string, unknown>[]>`
      select pricing_base_snapshot, pricing_version_snapshot, pricing_stages_snapshot,
             offer_round_id, driver_fee
      from order_driver_assignments where id = ${assigned.assignmentId}`;
    expect(row!.offer_round_id).toBeNull();
    expect(Number(row!.pricing_base_snapshot)).toBeGreaterThan(0);
    expect(Number(row!.pricing_version_snapshot)).toBeGreaterThan(0);
    const feeBefore = Number(row!.driver_fee);
    await h.cityDriverPricing.put(
      superIdentity,
      city,
      {
        pricingBase: 9000,
        roundingUnit: 250,
        pricingStages: [{ afterSeconds: 0, increasePercentage: 0 }],
      },
      "p3",
      crypto.randomUUID(),
    );
    const [again] = await h.client<{ driver_fee: number; pricing_base_snapshot: number }[]>`
      select driver_fee, pricing_base_snapshot from order_driver_assignments
      where id = ${assigned.assignmentId}`;
    expect(Number(again!.driver_fee)).toBe(feeBefore);
    expect(Number(again!.pricing_base_snapshot)).not.toBe(9000);
  });

  test("idempotency key conflict and concurrent duplicate claims", async () => {
    const driverId = await createOnlineDriver();
    const { round } = await createApprovedSearchingOrder();
    const key = crypto.randomUUID();
    const results = await Promise.allSettled([
      h.offers.claim(driverIdentity(driverId, city), round.id, key, "par1"),
      h.offers.claim(driverIdentity(driverId, city), round.id, key, "par2"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const [count] = await h.client<{ count: number }[]>`
      select count(*)::int as count from order_driver_assignments
      where offer_round_id = ${round.id} and cancelled_at is null`;
    expect(count!.count).toBe(1);

    const other = await createApprovedSearchingOrder();
    await expect(
      h.offers.claim(
        driverIdentity(driverId, city),
        other.round.id,
        key,
        "diff",
      ),
    ).rejects.toMatchObject({ publicCode: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("candidates read model batches and includes assignment summaries", async () => {
    const driverId = await createOnlineDriver();
    const first = await createApprovedSearchingOrder();
    await h.offers.claim(
      driverIdentity(driverId, city),
      first.round.id,
      crypto.randomUUID(),
      "cand1",
    );
    const second = await createApprovedSearchingOrder();
    await h.offers.assignDriver(
      adminIdentity,
      second.order.id,
      { driverId, reason: "PEAK" },
      crypto.randomUUID(),
      "cand2",
    );
    const listed = await h.offers.listDriverCandidates(adminIdentity, 1, 50);
    const row = listed.data.find((d) => d.driverId === driverId);
    expect(row).toBeTruthy();
    expect(row!.currentOrderSummary?.assignmentSequence).toBe(1);
    expect(row!.nextOrderSummary?.assignmentSequence).toBe(2);
    expect(row!.driverName).toBeTruthy();
    expect(row!.lastLocation).toBeNull();
    expect(row!.lastLocationAt).toBeNull();
    expect(row!.locationFreshness).toBe("MISSING");
    expect(["FRESH", "STALE", "MISSING"]).toContain(row!.locationFreshness);
  });

  test("DB rejects incomplete assignment pricing snapshot without round", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+96477${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const { order } = await createApprovedSearchingOrder();
    let rejected = false;
    try {
      await h.client`
        insert into order_driver_assignments (
          order_id, driver_id, city_id, offer_round_id, assignment_source,
          assignment_sequence, driver_fee
        ) values (
          ${order.id}, ${driverId}, ${city}, null, 'DASHBOARD_MANUAL', 1, 1000
        )`;
    } catch (error) {
      rejected = String(error).includes(
        "order_driver_assignments_pricing_source_chk",
      );
    }
    expect(rejected).toBe(true);
  });

  test("DB rejects invalid OPEN round with closedAt set", async () => {
    const { round } = await createApprovedSearchingOrder();
    let rejected = false;
    try {
      await h.client`
        update order_offer_rounds
        set closed_at = now()
        where id = ${round.id} and status = 'OPEN'`;
    } catch (error) {
      rejected = String(error).includes("order_offer_rounds_status_fields_chk");
    }
    expect(rejected).toBe(true);
  });
});
