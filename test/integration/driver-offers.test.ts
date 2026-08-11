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
    await h.orders.approve(adminIdentity, orderId, { kind: "DASHBOARD" });
    return h.offers.openRound(adminIdentity, orderId, "req", crypto.randomUUID());
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
    const driverId = await createDriverAccount(
      h.client,
      `+9647704${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const rounds = [];
    for (let i = 0; i < 6; i++) {
      rounds.push(await createApprovedSearchingOrder());
      await Bun.sleep(5);
    }
    const cards = await h.offers.spin(driverIdentity(driverId, city));
    expect(cards.length).toBe(5);
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual(["offerId", "offeredDriverFee"]);
      expect(card.offeredDriverFee).toBe(1000);
    }
  });

  test("BUSY driver cannot spin; successful claim returns orderTotal and paymentMethod", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+9647705${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
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
    ).rejects.toMatchObject({ publicCode: "DRIVER_NOT_AVAILABLE" });
  });

  test("two drivers race one offer — exactly one winner", async () => {
    const d1 = await createDriverAccount(
      h.client,
      `+9647706${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const d2 = await createDriverAccount(
      h.client,
      `+9647707${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
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
    const driverId = await createDriverAccount(
      h.client,
      `+9647708${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
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
    const driverId = await createDriverAccount(
      h.client,
      `+9647709${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
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
    const driverId = await createDriverAccount(
      h.client,
      `+9647710${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const otherDriver = await createDriverAccount(
      h.client,
      `+9647711${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
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
    const localDriver = await createDriverAccount(
      h.client,
      `+9647712${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const foreignDriver = await createDriverAccount(
      h.client,
      `+9647713${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      otherCity,
    );
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
  });

  test("idempotent claim retry does not duplicate assignment", async () => {
    const driverId = await createDriverAccount(
      h.client,
      `+9647714${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
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
    const driverId = await createDriverAccount(
      h.client,
      `+9647715${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      "123456",
      "ACTIVE",
      city,
    );
    const { order, round } = await createApprovedSearchingOrder();
    await h.offers.stopRound(adminIdentity, order.id, "PAUSE", "stop", crypto.randomUUID());
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
    // spin may surface stale redis then PG reconciliation should drop closed ones from effective list,
    // or claim must fail safely.
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
});
