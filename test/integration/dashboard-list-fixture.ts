import {
  createActiveCity,
  createDriverAccount,
  createStaffAccount,
  type IntegrationHarness,
} from "./helpers";

export const DASHBOARD_LIST_FIXTURE_PASSWORD = "fixed staff password";

export type DashboardListWorld = {
  cityA: string;
  cityB: string;
  storeId: string;
  orderId: string;
  adminAccountId: string;
  superToken: string;
  adminToken: string;
  adminBToken: string;
  employeeToken: string;
};

export async function seedDashboardListWorld(
  h: IntegrationHarness,
  password = DASHBOARD_LIST_FIXTURE_PASSWORD,
): Promise<DashboardListWorld> {
  const cityA = await createActiveCity(h.client, "ZXQ-CITY-HIT");
  const cityB = await createActiveCity(h.client, "Other City");
  await createStaffAccount(h.auth, h.client, {
    email: "super.lists@example.com",
    password,
    roles: ["SUPER_ADMIN"],
  });
  const adminAccountId = await createStaffAccount(h.auth, h.client, {
    email: "admin.lists@example.com",
    password,
    roles: ["ADMIN"],
    cityId: cityA,
  });
  await createStaffAccount(h.auth, h.client, {
    email: "adminb.lists@example.com",
    password,
    roles: ["ADMIN"],
    cityId: cityB,
  });
  await createStaffAccount(h.auth, h.client, {
    email: "ops.lists@example.com",
    password,
    roles: ["OPERATIONS"],
    cityId: cityA,
    managedByAccountId: adminAccountId,
  });
  await createStaffAccount(h.auth, h.client, {
    email: "noperm.lists@example.com",
    password,
    roles: ["SUPPORT"],
    cityId: cityA,
    managedByAccountId: adminAccountId,
  });
  const login = (email: string, requestId: string) =>
    h.auth.dashboard.login({
      email,
      password,
      deviceName: requestId,
      ip: "127.0.0.1",
      requestId,
    });
  const superToken = (await login("super.lists@example.com", "s")).access_token;
  const adminToken = (await login("admin.lists@example.com", "a")).access_token;
  const adminBToken = (await login("adminb.lists@example.com", "b")).access_token;
  const employeeToken = (await login("noperm.lists@example.com", "e")).access_token;

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
  const [main] = await h.client<{ id: string }[]>`
    insert into main_categories(city_id, name, image_asset_id, status, created_by_account_id)
    values (${cityA}, 'ZXQ-MAIN-HIT', ${media!.id}, 'ACTIVE', ${adminAccountId}) returning id`;
  await h.client`insert into main_category_translations(main_category_id,city_id,locale,name) values(${main!.id},${cityA},'ar','ZXQ-MAIN-HIT'),(${main!.id},${cityA},'en','ZXQ-MAIN-HIT')`;
  const [sub] = await h.client<{ id: string }[]>`
    insert into subcategories(city_id, main_category_id, name, status, created_by_account_id)
    values (${cityA}, ${main!.id}, 'ZXQ-SUB-HIT', 'ACTIVE', ${adminAccountId}) returning id`;
  await h.client`insert into subcategory_translations(subcategory_id,city_id,main_category_id,locale,name) values(${sub!.id},${cityA},${main!.id},'ar','ZXQ-SUB-HIT'),(${sub!.id},${cityA},${main!.id},'en','ZXQ-SUB-HIT')`;
  const [zone] = await h.client<{ id: string }[]>`
    insert into zones(city_id, name, boundary, status)
    values (
      ${cityA}, 'ZXQ-ZONE-HIT',
      ST_GeomFromText('POLYGON((44 33,45 33,45 34,44 34,44 33))', 4326),
      'ACTIVE'
    ) returning id`;
  await h.client`insert into zone_translations(zone_id,city_id,locale,name) values(${zone!.id},${cityA},'ar','ZXQ-ZONE-HIT'),(${zone!.id},${cityA},'en','ZXQ-ZONE-HIT')`;
  const [store] = await h.client<{ id: string }[]>`
    insert into stores(
      city_id, main_category_id, name, phone, address, location, logo_asset_id,
      status, order_acceptance_status, created_by_account_id, platform_commission_rate
    ) values (
      ${cityA}, ${main!.id}, 'ZXQ-STORE-HIT', '+9647001111222', 'Address',
      ST_SetSRID(ST_MakePoint(44.4, 33.3), 4326), ${logo!.id},
      'ACTIVE', 'ACCEPTING', ${adminAccountId}, 12
    ) returning id`;
  const storeId = store!.id;
  await h.client`insert into store_translations(store_id,city_id,locale,name,address) values(${storeId},${cityA},'ar','ZXQ-STORE-HIT','Address'),(${storeId},${cityA},'en','ZXQ-STORE-HIT','Address')`;
  await h.client`insert into store_zones(store_id, zone_id, city_id) values (${storeId}, ${zone!.id}, ${cityA})`;
  await h.client`
    insert into store_commission_rate_history(
      store_id, city_id, previous_rate, new_rate, reason, changed_by_account_id
    ) values (${storeId}, ${cityA}, 0, 12, 'ZXQ-HIST-HIT', ${adminAccountId})`;
  const [scat] = await h.client<{ id: string }[]>`
    insert into store_categories(store_id, city_id, name, status, created_by_account_id)
    values (${storeId}, ${cityA}, 'ZXQ-SCAT-HIT', 'ACTIVE', ${adminAccountId}) returning id`;
  await h.client`insert into store_category_translations(store_category_id,store_id,locale,name) values(${scat!.id},${storeId},'ar','ZXQ-SCAT-HIT'),(${scat!.id},${storeId},'en','ZXQ-SCAT-HIT')`;
  const [product] = await h.client<{ id: string }[]>`
    insert into products(store_id, city_id, category_id, name, base_price, is_available, status, created_by_account_id)
    values (${storeId}, ${cityA}, ${scat!.id}, 'ZXQ-PROD-HIT', 1000, true, 'ACTIVE', ${adminAccountId}) returning id`;
  await h.client`insert into product_translations(product_id,store_id,city_id,locale,name) values(${product!.id},${storeId},${cityA},'ar','ZXQ-PROD-HIT'),(${product!.id},${storeId},${cityA},'en','ZXQ-PROD-HIT')`;
  const [modifierGroup] = await h.client<{ id: string }[]>`
    insert into modifier_groups(store_id, city_id, name, min_select, max_select, status, created_by_account_id)
    values (${storeId}, ${cityA}, 'ZXQ-MOD-HIT', 0, 1, 'ACTIVE', ${adminAccountId}) returning id`;
  await h.client`insert into modifier_group_translations(modifier_group_id,store_id,city_id,locale,name) values(${modifierGroup!.id},${storeId},${cityA},'ar','ZXQ-MOD-HIT'),(${modifierGroup!.id},${storeId},${cityA},'en','ZXQ-MOD-HIT')`;

  const [merchant] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
  await h.client`insert into account_phones(account_id, phone_e164, verified_at, is_primary)
    values (${merchant!.id}, '+9647701999888', now(), true)`;
  await h.client`
    insert into merchant_profiles(account_id, store_id, city_id, display_name, status, created_by_account_id)
    values (${merchant!.id}, ${storeId}, ${cityA}, 'ZXQ-MERCH-HIT', 'ACTIVE', ${adminAccountId})`;

  const driverId = await createDriverAccount(
    h.client,
    "+9647701234001",
    "123456",
    "ACTIVE",
    cityA,
  );
  const driverB = await createDriverAccount(
    h.client,
    "+9647701234002",
    "123456",
    "ACTIVE",
    cityA,
  );
  const [customer] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
  await h.client`insert into customer_profiles(account_id) values (${customer!.id})`;

  const [order] = await h.client<{ id: string }[]>`
    insert into orders(
      order_number, city_id, zone_id, store_id, customer_account_id, status,
      payment_method, payment_status, products_subtotal, delivery_fee, total,
      currency, version, status_changed_at
    ) values (
      'ZXQ-ORD-HIT', ${cityA}, ${zone!.id}, ${storeId},
      ${customer!.id}, 'PENDING_STORE_APPROVAL', 'CASH', 'UNPAID',
      1000, 1000, 2000, 'IQD', 1, now()
    ) returning id`;
  const orderId = order!.id;
  await h.client`
    insert into order_events(order_id, event_type, actor_type, source)
    values (${orderId}, 'ORDER_CREATED', 'CUSTOMER', 'CUSTOMER_APP')`;

  const [round] = await h.client<{ id: string }[]>`
    insert into order_offer_rounds(
      order_id, city_id, status, pricing_base_snapshot, rounding_unit_snapshot,
      pricing_stages_snapshot, pricing_version_snapshot, created_by_account_id
    ) values (
      ${orderId}, ${cityA}, 'OPEN', 3000, 250,
      ${[{ afterSeconds: 0, increasePercentage: 0 }]},
      1, ${adminAccountId}
    ) returning id`;
  const [asg] = await h.client<{ id: string }[]>`
    insert into order_driver_assignments(
      order_id, driver_id, city_id, offer_round_id, assignment_source,
      assignment_sequence, assigned_by_account_id, driver_fee, status,
      pricing_base_snapshot, rounding_unit_snapshot, pricing_stages_snapshot,
      pricing_version_snapshot, pricing_stage_after_seconds, pricing_stage_increase_percentage
    ) values (
      ${orderId}, ${driverId}, ${cityA}, ${round!.id}, 'DASHBOARD_MANUAL',
      1, ${adminAccountId}, 3000, 'ASSIGNED',
      3000, 250, ${[{ afterSeconds: 0, increasePercentage: 0 }]},
      1, 0, 0
    ) returning id`;
  const [asg2] = await h.client<{ id: string }[]>`
    insert into order_driver_assignments(
      order_id, driver_id, city_id, assignment_source, assignment_sequence,
      assigned_by_account_id, driver_fee, status, cancelled_at,
      pricing_base_snapshot, rounding_unit_snapshot, pricing_stages_snapshot,
      pricing_version_snapshot, pricing_stage_after_seconds, pricing_stage_increase_percentage
    ) values (
      ${orderId}, ${driverB}, ${cityA}, 'DASHBOARD_MANUAL', 2,
      ${adminAccountId}, 3000, 'ASSIGNED', now(),
      3000, 250, ${[{ afterSeconds: 0, increasePercentage: 0 }]},
      1, 0, 0
    ) returning id`;
  await h.client`
    insert into order_driver_handoffs(
      order_id, city_id, from_assignment_id, to_assignment_id,
      from_driver_id, to_driver_id, status, reason, started_by_account_id
    ) values (
      ${orderId}, ${cityA}, ${asg!.id}, ${asg2!.id},
      ${driverId}, ${driverB}, 'PENDING', 'handoff', ${adminAccountId}
    )`;
  await h.client`
    insert into order_return_workflows(
      order_id, city_id, assignment_id, driver_id, status, reason, started_by_account_id
    ) values (
      ${orderId}, ${cityA}, ${asg!.id}, ${driverId},
      'WAITING_FOR_DRIVER_RETURN', 'return', ${adminAccountId}
    )`;
  const [collEvent] = await h.client<{ id: string }[]>`
    insert into order_events(order_id, assignment_id, event_type, actor_type, source)
    values (${orderId}, ${asg!.id}, 'ORDER_DELIVERED', 'DRIVER', 'DRIVER_APP') returning id`;
  await h.client`
    insert into order_collections(
      order_id, assignment_id, collecting_driver_id, expected_amount, collected_amount,
      difference_amount, confirmed_by_account_id, confirmation_source, order_event_id, collected_at
    ) values (
      ${orderId}, ${asg!.id}, ${driverId}, 2000, 2000, 0,
      ${adminAccountId}, 'DRIVER_APP', ${collEvent!.id}, now()
    )`;

  await h.client`
    insert into city_delivery_pricing_versions(
      city_id, version, base_fee, included_distance_meters, price_per_km, rounding_step,
      maximum_delivery_distance_meters, routing_fallback_enabled, fallback_on_no_route,
      fallback_on_provider_failure, fallback_extra_distance_meters, created_by_account_id, status
    ) values (
      ${cityA}, 1, 1000, 1000, 500, 250, 20000, false, false, false, 0, ${adminAccountId}, 'DRAFT'
    )`;

  return {
    cityA,
    cityB,
    storeId,
    orderId,
    adminAccountId,
    superToken,
    adminToken,
    adminBToken,
    employeeToken,
  };
}
