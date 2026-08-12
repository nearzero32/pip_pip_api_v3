// @ts-nocheck
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AuthIdentity } from "../../src/modules/auth/sessions/session-service";
import { customerContext } from "../../src/modules/auth/core/context";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

type OrderAny = any;

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

describe("M4-A Orders Core", () => {
  let h: IntegrationHarness;
  let city = "";
  let city2 = "";
  let store = "";
  let store2 = "";
  let product = "";
  let productAlt = "";
  let productExpensive = "";
  let productCheap = "";
  let unavailable = "";
  let zoneId = "";
  let customer = "";
  let otherCustomer = "";
  let addressId = "";
  let city2AddressId = "";
  let adminId = "";
  let adminIdentity!: AuthIdentity;
  let opsId = "";
  let opsIdentity!: AuthIdentity;
  let opsNoPermIdentity!: AuthIdentity;
  let superIdentity!: AuthIdentity;
  let merchantId = "";
  let merchantIdentity!: AuthIdentity;
  let token = "";
  let adminToken = "";
  let superId = "";

  const createBody = (overrides: Record<string, unknown> = {}) => ({
    storeId: store,
    addressId,
    paymentMethod: "CASH" as const,
    items: [{ productId: product, quantity: 2 }],
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  });

  beforeAll(async () => {
    h = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_orders" });
    city = await createActiveCity(h.client, "Orders City");
    city2 = await createActiveCity(h.client, "Orders City 2");

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
    const logos = await h.client<{ id: string }[]>`
      insert into media_assets(
        city_id, purpose, visibility, status, object_key, original_name,
        expected_content_type, expected_size_bytes, verified_content_type,
        verified_size_bytes, created_by_account_id, upload_expires_at, ready_at, attached_at
      ) values
        (${city}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l1.png', 'image/png', 1, 'image/png', 1, ${superId}, now(), now(), now()),
        (${city}, 'STORE_LOGO', 'PUBLIC', 'READY', ${crypto.randomUUID()}, 'l2.png', 'image/png', 1, 'image/png', 1, ${superId}, now(), now(), now())
      returning id`;
    if (logos.length !== 2 || logos[0]!.id === logos[1]!.id)
      throw new Error("expected two distinct store logos");
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
        ${city},
        'Delivery',
        ST_GeomFromText('POLYGON((44 33,45 33,45 34,44 34,44 33))', 4326),
        'ACTIVE'
      ) returning id`;
    zoneId = z!.id;
    await h.client`insert into store_zones(store_id, zone_id, city_id) values (${store}, ${zoneId}, ${city})`;
    await h.client`insert into store_zones(store_id, zone_id, city_id) values (${store2}, ${zoneId}, ${city})`;

    const [p] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${store}, ${city}, 'منتج', 1000, true, 'ACTIVE', ${superId}) returning id`;
    product = p!.id;
    const [pAlt] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${store2}, ${city}, 'منتج متجر آخر', 1500, true, 'ACTIVE', ${superId}) returning id`;
    productAlt = pAlt!.id;
    const [pExp] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${store}, ${city}, 'أغلى', 2500, true, 'ACTIVE', ${superId}) returning id`;
    productExpensive = pExp!.id;
    const [pCheap] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${store}, ${city}, 'أرخص', 500, true, 'ACTIVE', ${superId}) returning id`;
    productCheap = pCheap!.id;
    const [pUn] = await h.client<{ id: string }[]>`
      insert into products(store_id, city_id, name, base_price, is_available, status, created_by_account_id)
      values (${store}, ${city}, 'غير متاح', 1000, false, 'ACTIVE', ${superId}) returning id`;
    unavailable = pUn!.id;

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
      "orders-driver-pricing",
      crypto.randomUUID(),
    );
    h.routingProvider.setResult({ distanceMeters: 1000, durationSeconds: 120 });

    const [c] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    customer = c!.id;
    await h.client`insert into customer_profiles(account_id) values (${customer})`;
    const [oc] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    otherCustomer = oc!.id;
    await h.client`insert into customer_profiles(account_id) values (${otherCustomer})`;

    const addr = await h.addresses.create(customer, city, {
      label: "البيت",
      location: { latitude: 33.31, longitude: 44.41 },
      addressDetails: "تفاصيل",
    });
    addressId = addr.id;
    const city2Addr = await h.addresses.create(customer, city2, {
      label: "مدينة أخرى",
      location: { latitude: 33.31, longitude: 44.41 },
      addressDetails: "تفاصيل",
    });
    city2AddressId = city2Addr.id;

    const created = await h.client.begin((tx) =>
      h.auth.sessions.create(tx, customer, customerContext, "PHONE_OTP", undefined, "orders"),
    );
    token = (await h.auth.sessions.result(customer, created, customerContext)).access_token;

    adminId = await createStaffAccount(h.auth, h.client, {
      email: "orders-admin@example.com",
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
        email: "orders-admin@example.com",
        password: "fixed dashboard password",
        deviceName: "orders-admin",
        ip: "orders-admin",
        requestId: "orders-admin",
      })
    ).access_token;

    opsId = await createStaffAccount(h.auth, h.client, {
      email: "orders-ops@example.com",
      password: "fixed dashboard password",
      roles: ["OPERATIONS"],
      cityId: city,
      managedByAccountId: adminId,
    });
    for (const code of [
      "orders.read",
      "orders.cancel",
      "orders.approve",
      "orders.items.replace",
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
      email: "orders-ops-none@example.com",
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
      insert into account_emails(account_id, email_original, email_normalized, verified_at, is_primary)
      values (${merchantId}, 'merchant-orders@example.com', 'merchant-orders@example.com', now(), true)`;
    await h.client`
      insert into merchant_profiles(account_id, store_id, city_id, display_name, status, created_by_account_id)
      values (${merchantId}, ${store}, ${city}, 'Merchant', 'ACTIVE', ${adminId})`;
    merchantIdentity = {
      accountId: merchantId,
      sessionId: null as unknown as string,
      applicationType: "MERCHANT_APP",
      roles: [],
      scopeType: null,
      cityId: city,
      storeId: store,
    };
  });

  afterAll(() => h?.close());

  test("creates CASH order with PENDING_STORE_APPROVAL, history, and trusted totals", async () => {
    await h.client`update products set base_price = 1000 where id = ${product}`;
    const order = await h.orders.create(customer, city, createBody({
      items: [{ productId: product, quantity: 2 }],
      idempotencyKey: `cash-${crypto.randomUUID()}`,
    }));
    expect(order).toMatchObject({
      status: "PENDING_STORE_APPROVAL",
      paymentMethod: "CASH",
      paymentStatus: "UNPAID",
      productsSubtotal: 2000,
      currency: "IQD",
    });
    expect(order.deliveryFee).toBeGreaterThan(0);
    expect(order.total).toBe(order.productsSubtotal + order.deliveryFee);
    expect(order.items).toHaveLength(1);
    expect(order.items![0]).toMatchObject({
      productName: "منتج",
      unitPrice: 1000,
      quantity: 2,
      state: "ACTIVE",
    });

    const history = await h.client<
      { from_status: string | null; to_status: string; exited_at: Date | null; duration_seconds: number | null }[]
    >`select from_status::text, to_status::text, exited_at, duration_seconds
      from order_status_history where order_id = ${order.id}`;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      from_status: null,
      to_status: "PENDING_STORE_APPROVAL",
      exited_at: null,
      duration_seconds: null,
    });

    const openCount = await h.client<{ count: number }[]>`
      select count(*)::int count from order_status_history
      where order_id = ${order.id} and exited_at is null`;
    expect(openCount[0]!.count).toBe(1);
  });

  test("ONLINE creation is rejected atomically with ORDER_ONLINE_PAYMENT_NOT_CONFIRMED", async () => {
    const before = await h.client<{
      orders: number;
      items: number;
      history: number;
      addresses: number;
      pricing: number;
      idem: number;
    }[]>`
      select
        (select count(*)::int from orders) orders,
        (select count(*)::int from order_items) items,
        (select count(*)::int from order_status_history) history,
        (select count(*)::int from order_address_snapshots) addresses,
        (select count(*)::int from order_delivery_pricing_snapshots) pricing,
        (select count(*)::int from order_idempotency_keys) idem`;
    const key = `online-${crypto.randomUUID()}`;
    await expect(
      h.orders.create(customer, city, createBody({
        paymentMethod: "ONLINE",
        idempotencyKey: key,
      })),
    ).rejects.toMatchObject({ publicCode: "ORDER_ONLINE_PAYMENT_NOT_CONFIRMED" });
    const http = await h.app.handle(
      jsonRequest("/api/v1/mobile/customer/orders", {
        token,
        headers: { "x-city-id": city },
        body: createBody({
          paymentMethod: "ONLINE",
          idempotencyKey: `http-online-${crypto.randomUUID()}`,
        }),
      }),
    );
    expect(http.status).toBe(409);
    expect(await http.json()).toMatchObject({
      error: { code: "ORDER_ONLINE_PAYMENT_NOT_CONFIRMED" },
    });
    const after = await h.client<{
      orders: number;
      items: number;
      history: number;
      addresses: number;
      pricing: number;
      idem: number;
    }[]>`
      select
        (select count(*)::int from orders) orders,
        (select count(*)::int from order_items) items,
        (select count(*)::int from order_status_history) history,
        (select count(*)::int from order_address_snapshots) addresses,
        (select count(*)::int from order_delivery_pricing_snapshots) pricing,
        (select count(*)::int from order_idempotency_keys) idem`;
    expect(after[0]).toEqual(before[0]);
    const idemRow = await h.client<{ count: number }[]>`
      select count(*)::int count from order_idempotency_keys
      where customer_account_id = ${customer} and city_id = ${city} and idempotency_key = ${key}`;
    expect(idemRow[0]!.count).toBe(0);
  });

  test("fixture ONLINE AWAITING_PAYMENT order cannot be approved or replaced", async () => {
    const [order] = await h.client<{ id: string }[]>`
      insert into orders(
        order_number, city_id, zone_id, store_id, customer_account_id, status,
        payment_method, payment_status, products_subtotal, delivery_fee, total,
        currency, version, status_changed_at
      ) values (
        ${`PP-ONLINE-${crypto.randomUUID().slice(0, 8)}`}, ${city}, ${zoneId}, ${store},
        ${customer}, 'PENDING_STORE_APPROVAL', 'ONLINE', 'AWAITING_PAYMENT',
        1000, 1000, 2000, 'IQD', 1, now()
      ) returning id::text`;
    const [item] = await h.client<{ id: string }[]>`
      insert into order_items(
        order_id, product_id, product_name_snapshot, unit_price_snapshot,
        modifiers_price_snapshot, quantity, line_total, state
      ) values (
        ${order!.id}, ${product}, 'منتج', 1000, 0, 1, 1000, 'ACTIVE'
      ) returning id::text`;
    await h.client`
      insert into order_status_history(
        order_id, from_status, to_status, entered_at, changed_by_account_id,
        actor_type, source
      ) values (
        ${order!.id}, null, 'PENDING_STORE_APPROVAL', now(), ${customer},
        'CUSTOMER', 'CUSTOMER_APP'
      )`;
    await expect(
      h.orders.approve(adminIdentity, order!.id, { kind: "DASHBOARD" }),
    ).rejects.toMatchObject({ publicCode: "ORDER_ONLINE_PAYMENT_NOT_CONFIRMED" });
    await expect(
      h.orders.replaceItem(
        adminIdentity,
        order!.id,
        item!.id,
        {
          productId: productCheap,
          quantity: 1,
          reason: "يجب ألا يُسمح",
          customerAgreedByPhone: true,
        },
        { kind: "DASHBOARD" },
      ),
    ).rejects.toMatchObject({ publicCode: "ORDER_ONLINE_PAYMENT_NOT_CONFIRMED" });
    const status = await h.client<{ status: string; version: number }[]>`
      select status::text, version from orders where id = ${order!.id}`;
    expect(status[0]).toMatchObject({ status: "PENDING_STORE_APPROVAL", version: 1 });
    const replacements = await h.client<{ count: number }[]>`
      select count(*)::int count from order_item_replacements where order_id = ${order!.id}`;
    expect(replacements[0]!.count).toBe(0);
  });

  test("product prices and delivery fee ignore client-supplied money fields", async () => {
    const response = await h.app.handle(
      jsonRequest("/api/v1/mobile/customer/orders", {
        token,
        headers: { "x-city-id": city },
        body: {
          ...createBody({ idempotencyKey: `http-${crypto.randomUUID()}` }),
          productsSubtotal: 1,
          deliveryFee: 1,
          total: 1,
          items: [{ productId: product, quantity: 1, unitPrice: 1 }],
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      productsSubtotal: number;
      deliveryFee: number;
      total: number;
      items: Array<{ unitPrice: number }>;
    };
    expect(body.productsSubtotal).toBe(1000);
    expect(body.deliveryFee).not.toBe(1);
    expect(body.total).toBe(body.productsSubtotal + body.deliveryFee);
    expect(body.items[0]!.unitPrice).toBe(1000);
  });

  test("address and delivery snapshots survive source mutations", async () => {
    const order = await h.orders.create(customer, city, createBody({
      idempotencyKey: `snap-${crypto.randomUUID()}`,
    }));
    const feeBefore = order.deliveryFee;
    await h.client`update customer_addresses set label = 'changed', address_details = 'new-details' where id = ${addressId}`;
    await h.client`update products set name = 'renamed', base_price = 9999 where id = ${product}`;
    const detail = await h.orders.getForDashboard(adminIdentity, order.id);
    expect(detail.addressSnapshot).toMatchObject({
      label: "البيت",
      addressDetails: "تفاصيل",
    });
    expect(detail.deliveryPricingSnapshot.deliveryFee).toBe(feeBefore);
    expect(detail.items[0].productName).toBe("منتج");
    expect(detail.items[0].unitPrice).toBe(1000);
  });

  test("rejects empty items, unavailable products, and cross-store items", async () => {
    await expect(
      h.orders.create(customer, city, createBody({ items: [], idempotencyKey: crypto.randomUUID() })),
    ).rejects.toMatchObject({ publicCode: "ORDER_EMPTY" });
    await expect(
      h.orders.create(customer, city, createBody({
        items: [{ productId: unavailable, quantity: 1 }],
        idempotencyKey: crypto.randomUUID(),
      })),
    ).rejects.toMatchObject({ publicCode: "ORDER_ITEM_UNAVAILABLE" });
    await expect(
      h.orders.create(customer, city, createBody({
        items: [{ productId: productAlt, quantity: 1 }],
        idempotencyKey: crypto.randomUUID(),
      })),
    ).rejects.toMatchObject({ publicCode: "ORDER_ITEM_UNAVAILABLE" });
  });

  test("cross-city store/address are not found and leave no orphan order", async () => {
    const before = await h.client<{ count: number }[]>`select count(*)::int count from orders`;
    await expect(
      h.orders.create(customer, city2, createBody({
        addressId: city2AddressId,
        idempotencyKey: crypto.randomUUID(),
      })),
    ).rejects.toMatchObject({ publicCode: "STORE_NOT_FOUND" });
    await expect(
      h.orders.create(customer, city, createBody({
        addressId: city2AddressId,
        idempotencyKey: crypto.randomUUID(),
      })),
    ).rejects.toMatchObject({ publicCode: "ADDRESS_NOT_FOUND" });
    const after = await h.client<{ count: number }[]>`select count(*)::int count from orders`;
    expect(after[0]!.count).toBe(before[0]!.count);
  });

  test("delivery unavailable creates no partial order rows", async () => {
    const beforeOrders = await h.client<{ count: number }[]>`select count(*)::int count from orders`;
    const beforeItems = await h.client<{ count: number }[]>`select count(*)::int count from order_items`;
    const beforeHist = await h.client<{ count: number }[]>`select count(*)::int count from order_status_history`;
    const outside = await h.addresses.create(customer, city, {
      label: "خارج",
      location: { latitude: 10, longitude: 10 },
      addressDetails: "خارج المنطقة",
    });
    await expect(
      h.orders.create(customer, city, createBody({
        addressId: outside.id,
        idempotencyKey: crypto.randomUUID(),
      })),
    ).rejects.toMatchObject({ publicCode: "ORDER_DELIVERY_UNAVAILABLE" });
    const afterOrders = await h.client<{ count: number }[]>`select count(*)::int count from orders`;
    const afterItems = await h.client<{ count: number }[]>`select count(*)::int count from order_items`;
    const afterHist = await h.client<{ count: number }[]>`select count(*)::int count from order_status_history`;
    expect(afterOrders[0]!.count).toBe(beforeOrders[0]!.count);
    expect(afterItems[0]!.count).toBe(beforeItems[0]!.count);
    expect(afterHist[0]!.count).toBe(beforeHist[0]!.count);
  });

  test("idempotency: same key/payload replays; different payload conflicts; concurrent creates once", async () => {
    const key = `idem-${crypto.randomUUID()}`;
    const body = createBody({ idempotencyKey: key, items: [{ productId: product, quantity: 1 }] });
    const first = await h.orders.create(customer, city, body);
    const second = await h.orders.create(customer, city, body);
    expect(second.id).toBe(first.id);
    await expect(
      h.orders.create(customer, city, {
        ...body,
        items: [{ productId: product, quantity: 2 }],
      }),
    ).rejects.toMatchObject({ publicCode: "ORDER_IDEMPOTENCY_CONFLICT" });

    const concurrentKey = `conc-${crypto.randomUUID()}`;
    const concurrentBody = createBody({
      idempotencyKey: concurrentKey,
      items: [{ productId: product, quantity: 1 }],
    });
    const results = await Promise.all([
      h.orders.create(customer, city, concurrentBody),
      h.orders.create(customer, city, concurrentBody),
    ]);
    expect(results[0]!.id).toBe(results[1]!.id);
    const count = await h.client<{ count: number }[]>`
      select count(*)::int count from orders
      where customer_account_id = ${customer}
        and id in (${results[0]!.id}, ${results[1]!.id})`;
    expect(count[0]!.count).toBe(1);
  });

  test("customer cancel only own PENDING_STORE_APPROVAL order", async () => {
    const order = await h.orders.create(customer, city, createBody({
      idempotencyKey: `cancel-c-${crypto.randomUUID()}`,
    }));
    const cancelled = await h.orders.cancelByCustomer(customer, city, order.id, "غيرت رأيي");
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledAt).toBeTruthy();
    const audit = await h.client<{ previous_status: string; source: string }[]>`
      select previous_status::text, source::text from order_cancellations where order_id = ${order.id}`;
    expect(audit[0]).toMatchObject({
      previous_status: "PENDING_STORE_APPROVAL",
      source: "CUSTOMER_APP",
    });

    await expect(
      h.orders.cancelByCustomer(otherCustomer, city, order.id, "لا"),
    ).rejects.toMatchObject({ publicCode: "ORDER_NOT_FOUND" });

    const approved = await h.orders.create(customer, city, createBody({
      idempotencyKey: `cancel-after-${crypto.randomUUID()}`,
    }));
    await h.orders.approve(adminIdentity, approved.id, { kind: "DASHBOARD" });
    await expect(
      h.orders.cancelByCustomer(customer, city, approved.id, "متأخر"),
    ).rejects.toMatchObject({ publicCode: "ORDER_CANCELLATION_NOT_ALLOWED" });
  });

  test("dashboard cancel requires permission and reason; SUPER_ADMIN blocked; cross-city hidden", async () => {
    const order = await h.orders.create(customer, city, createBody({
      idempotencyKey: `dash-cancel-${crypto.randomUUID()}`,
    }));
    await expect(
      h.orders.cancelByDashboard(opsNoPermIdentity, order.id, "سبب"),
    ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });
    await expect(
      h.orders.cancelByDashboard(superIdentity, order.id, "سبب"),
    ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });
    await expect(
      h.orders.cancelByDashboard(adminIdentity, order.id, "   "),
    ).rejects.toMatchObject({ publicCode: "VALIDATION_FAILED" });

    const cancelled = await h.orders.cancelByDashboard(adminIdentity, order.id, "طلب العميل");
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancellation.reason).toBe("طلب العميل");

    const otherCityAdmin = await createStaffAccount(h.auth, h.client, {
      email: "orders-admin-city2@example.com",
      password: "fixed dashboard password",
      roles: ["ADMIN"],
      cityId: city2,
    });
    await expect(
      h.orders.cancelByDashboard(
        {
          accountId: otherCityAdmin,
          sessionId: crypto.randomUUID(),
          applicationType: "DASHBOARD",
          roles: ["ADMIN"],
          scopeType: "CITY",
          cityId: city2,
          storeId: null,
        },
        order.id,
        "سبب",
      ),
    ).rejects.toMatchObject({ publicCode: "ORDER_NOT_FOUND" });
  });

  test("store and driver have no cancellation HTTP endpoints", async () => {
    const doc = (await (
      await h.app.handle(new Request("http://localhost/openapi/json"))
    ).json()) as { paths: Record<string, unknown> };
    const paths = Object.keys(doc.paths);
    expect(paths.some((p) => p.includes("/merchant/orders") && p.endsWith("/cancel"))).toBe(
      false,
    );
    expect(
      paths.some((p) => p.includes("/driver/orders") && p.endsWith("/cancel")),
    ).toBe(false);
  });

  test("item replacement preserves original, recalculates totals, keeps delivery fee", async () => {
    const order = await h.orders.create(customer, city, createBody({
      items: [{ productId: product, quantity: 1 }],
      idempotencyKey: `rep-${crypto.randomUUID()}`,
    }));
    const itemId = order.items![0]!.id as string;
    const fee = order.deliveryFee;
    const expensive = await h.orders.replaceItem(
      merchantIdentity,
      order.id,
      itemId,
      {
        productId: productExpensive,
        quantity: 1,
        reason: "غير متوفر، تم الاتفاق هاتفياً",
        customerAgreedByPhone: true,
      },
      { kind: "MERCHANT", storeId: store },
    );
    expect(expensive.productsSubtotal).toBe(2500);
    expect(expensive.deliveryFee).toBe(fee);
    expect(expensive.total).toBe(2500 + fee);
    expect(expensive.status).toBe("PENDING_STORE_APPROVAL");
    const items = expensive.items as Array<{ id: string; state: string; replacesOrderItemId: string | null }>;
    const original = items.find((i) => i.id === itemId);
    const replacement = items.find((i) => i.replacesOrderItemId === itemId);
    expect(original?.state).toBe("REPLACED");
    expect(replacement?.state).toBe("ACTIVE");

    const cheap = await h.orders.replaceItem(
      opsIdentity,
      order.id,
      replacement!.id,
      {
        productId: productCheap,
        quantity: 2,
        reason: "بديل أرخص بالاتفاق",
        customerAgreedByPhone: true,
      },
      { kind: "DASHBOARD" },
    );
    expect(cheap.productsSubtotal).toBe(1000);
    expect(cheap.deliveryFee).toBe(fee);

    await expect(
      h.orders.replaceItem(
        adminIdentity,
        order.id,
        itemId,
        {
          productId: productCheap,
          quantity: 1,
          reason: "مرة أخرى",
          customerAgreedByPhone: true,
        },
        { kind: "DASHBOARD" },
      ),
    ).rejects.toMatchObject({ publicCode: "ORDER_ITEM_ALREADY_REPLACED" });

    await expect(
      h.orders.replaceItem(
        adminIdentity,
        order.id,
        (cheap.items as Array<{ id: string; state: string }>).find((i) => i.state === "ACTIVE")!
          .id,
        {
          productId: productAlt,
          quantity: 1,
          reason: "متجر آخر",
          customerAgreedByPhone: true,
        },
        { kind: "DASHBOARD" },
      ),
    ).rejects.toMatchObject({ publicCode: "ORDER_ITEM_UNAVAILABLE" });
  });

  test("concurrent replacements against the same item produce one success", async () => {
    const order = await h.orders.create(customer, city, createBody({
      items: [{ productId: product, quantity: 1 }],
      idempotencyKey: `conc-rep-${crypto.randomUUID()}`,
    }));
    const itemId = order.items![0]!.id as string;
    const feeBefore = order.deliveryFee;
    const [pricingBefore] = await h.client<
      { delivery_fee: number; distance_meters: number; pricing_version_id: string }[]
    >`select delivery_fee, distance_meters, pricing_version_id::text
      from order_delivery_pricing_snapshots where order_id = ${order.id}`;

    const results = await Promise.allSettled([
      h.orders.replaceItem(
        merchantIdentity,
        order.id,
        itemId,
        {
          productId: productExpensive,
          quantity: 1,
          reason: "concurrent A",
          customerAgreedByPhone: true,
        },
        { kind: "MERCHANT", storeId: store },
      ),
      h.orders.replaceItem(
        adminIdentity,
        order.id,
        itemId,
        {
          productId: productCheap,
          quantity: 2,
          reason: "concurrent B",
          customerAgreedByPhone: true,
        },
        { kind: "DASHBOARD" },
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectedCode = (rejected[0] as PromiseRejectedResult).reason
      ?.publicCode as string;
    expect([
      "ORDER_ITEM_ALREADY_REPLACED",
      "ORDER_INVALID_STATE",
    ]).toContain(rejectedCode);

    const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    const active = (winner.items as Array<{ state: string; lineTotal: number }>).filter(
      (i) => i.state === "ACTIVE",
    );
    expect(active).toHaveLength(1);
    expect(winner.productsSubtotal).toBe(active[0]!.lineTotal);
    expect(winner.deliveryFee).toBe(feeBefore);
    expect(winner.total).toBe(winner.productsSubtotal + feeBefore);

    const replacementItems = await h.client<{ count: number }[]>`
      select count(*)::int count from order_items
      where order_id = ${order.id} and replaces_order_item_id = ${itemId}`;
    expect(replacementItems[0]!.count).toBe(1);
    const audits = await h.client<{ count: number }[]>`
      select count(*)::int count from order_item_replacements
      where order_id = ${order.id} and original_order_item_id = ${itemId}`;
    expect(audits[0]!.count).toBe(1);

    const [pricingAfter] = await h.client<
      { delivery_fee: number; distance_meters: number; pricing_version_id: string }[]
    >`select delivery_fee, distance_meters, pricing_version_id::text
      from order_delivery_pricing_snapshots where order_id = ${order.id}`;
    expect(pricingAfter).toEqual(pricingBefore);
  });

  test("replacement remains open after approval; unauthorized employee fails", async () => {
    const order = await h.orders.create(customer, city, createBody({
      idempotencyKey: `rep-appr-${crypto.randomUUID()}`,
    }));
    const itemId = order.items![0]!.id as string;
    await h.orders.approve(merchantIdentity, order.id, {
      kind: "MERCHANT",
      storeId: store,
    });
    const afterApproval = await h.orders.replaceItem(
        adminIdentity,
        order.id,
        itemId,
        {
          productId: productCheap,
          quantity: 1,
          reason: "بعد الموافقة",
          customerAgreedByPhone: true,
        },
        { kind: "DASHBOARD" },
      );
    expect(afterApproval.status).toBe("SEARCHING_DRIVER");
    await expect(
      h.orders.replaceItem(
        opsNoPermIdentity,
        order.id,
        itemId,
        {
          productId: productCheap,
          quantity: 1,
          reason: "بدون صلاحية",
          customerAgreedByPhone: true,
        },
        { kind: "DASHBOARD" },
      ),
    ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });
  });

  test("approval closes history with duration and replays duplicate approval", async () => {
    const order = await h.orders.create(customer, city, createBody({
      idempotencyKey: `appr-${crypto.randomUUID()}`,
    }));
    await new Promise((r) => setTimeout(r, 1100));
    const approved = await h.orders.approve(adminIdentity, order.id, { kind: "DASHBOARD" });
    expect(approved.status).toBe("SEARCHING_DRIVER");
    const history = approved.statusHistory as Array<{
      toStatus: string;
      exitedAt: string | null;
      durationSeconds: number | null;
    }>;
    const first = history.find((h) => h.toStatus === "PENDING_STORE_APPROVAL");
    expect(first?.exitedAt).toBeTruthy();
    expect(first!.durationSeconds!).toBeGreaterThanOrEqual(1);
    expect(history.filter((h) => h.exitedAt == null)).toHaveLength(1);
    const replay = await h.orders.approve(adminIdentity, order.id, { kind: "DASHBOARD" });
    expect(replay.status).toBe("SEARCHING_DRIVER");
  });

  test("concurrent approvals converge on one offer round", async () => {
    const order = await h.orders.create(customer, city, createBody({
      idempotencyKey: `conc-appr-${crypto.randomUUID()}`,
    }));
    const results = await Promise.allSettled([
      h.orders.approve(adminIdentity, order.id, { kind: "DASHBOARD" }),
      h.orders.approve(merchantIdentity, order.id, {
        kind: "MERCHANT",
        storeId: store,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    const row = await h.client<{ status: string; version: number }[]>`
      select status::text, version from orders where id = ${order.id}`;
    expect(row[0]!.status).toBe("SEARCHING_DRIVER");
    expect(row[0]!.version).toBe(2);
  });

  test("customer reads own orders only; SUPER_ADMIN blocked from city list", async () => {
    const order = await h.orders.create(customer, city, createBody({
      idempotencyKey: `read-${crypto.randomUUID()}`,
    }));
    const mine = await h.orders.getForCustomer(customer, city, order.id);
    expect(mine.id).toBe(order.id);
    await expect(
      h.orders.getForCustomer(otherCustomer, city, order.id),
    ).rejects.toMatchObject({ publicCode: "ORDER_NOT_FOUND" });
    await expect(h.orders.listForDashboard(superIdentity)).rejects.toMatchObject({
      publicCode: "FORBIDDEN",
    });
    const list = await h.orders.listForStore(store, city);
    expect(list.data.some((o: { id: string }) => o.id === order.id)).toBe(true);
    const otherStore = await h.orders.listForStore(store2, city);
    expect(otherStore.data.some((o: { id: string }) => o.id === order.id)).toBe(false);
  });

  test("permission revocation blocks employee cancel immediately", async () => {
    const order = await h.orders.create(customer, city, createBody({
      idempotencyKey: `revoke-${crypto.randomUUID()}`,
    }));
    await h.app.handle(
      jsonRequest(`/api/v1/dashboard/employees/${opsId}/permissions/orders.cancel`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    await expect(
      h.orders.cancelByDashboard(opsIdentity, order.id, "سبب"),
    ).rejects.toMatchObject({ publicCode: "FORBIDDEN" });
  });

  test("OpenAPI documents order routes", async () => {
    const doc = (await (
      await h.app.handle(new Request("http://localhost/openapi/json"))
    ).json()) as { paths: Record<string, unknown> };
    expect(doc.paths["/api/v1/mobile/customer/orders"]).toBeTruthy();
    expect(doc.paths["/api/v1/dashboard/orders"]).toBeTruthy();
    expect(doc.paths["/api/v1/mobile/merchant/orders"]).toBeTruthy();
    expect(
      doc.paths["/api/v1/mobile/customer/orders/{orderId}/cancel"],
    ).toBeTruthy();
    expect(doc.paths["/api/v1/dashboard/orders/{orderId}/approve"]).toBeTruthy();
    const createContract = JSON.stringify(
      doc.paths["/api/v1/mobile/customer/orders"],
    );
    expect(createContract).toContain("orderNumber");
    expect(createContract).toContain("productsSubtotal");
    expect(createContract).not.toContain('"t.Any"');
    expect(createContract).not.toContain("statusHistory");
    expect(createContract).not.toContain("actorAccountId");
    expect(createContract).not.toContain("rawCalculation");
  });
});
