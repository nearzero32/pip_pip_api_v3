import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { customerContext } from "../../src/modules/auth/core/context";
import {
  MAX_ADDRESSES_PER_CUSTOMER_CITY,
} from "../../src/modules/customer-addresses/customer-address.service";
import {
  createActiveCity,
  createIntegrationHarness,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

const square = (west: number, south: number, east: number, north: number) => ({
  type: "Polygon" as const,
  coordinates: [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ],
});

const pointInside = { latitude: 33.15, longitude: 44.15 };
const pointOutside = { latitude: 10, longitude: 10 };

const baseBody = (overrides: Record<string, unknown> = {}) => ({
  label: "البيت",
  location: pointInside,
  addressDetails: "حي الجزائر، شارع 14، دار 22",
  landmark: "مقابل صيدلية الشفاء",
  recipientName: null,
  recipientPhone: null,
  ...overrides,
});

describe("Customer Saved Addresses", () => {
  let h: IntegrationHarness & { trackedQueries?: string[] };
  let city = "";
  let city2 = "";
  let zoneId = "";
  let zoneName = "الجزائر";
  let inactiveZoneId = "";
  let customer = "";
  let otherCustomer = "";
  let token = "";
  let otherToken = "";

  beforeAll(async () => {
    h = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_addresses",
      trackClient: true,
    });
    city = await createActiveCity(h.client, "Address City");
    city2 = await createActiveCity(h.client, "Address City 2");

    const [zone] = await h.client<{ id: string }[]>`
      insert into zones(city_id, name, boundary, status)
      values (
        ${city},
        ${zoneName},
        ST_SetSRID(
          ST_GeomFromGeoJSON(${JSON.stringify(square(44.1, 33.1, 44.2, 33.2))}),
          4326
        ),
        'ACTIVE'
      )
      returning id`;
    zoneId = zone!.id;

    const [inactive] = await h.client<{ id: string }[]>`
      insert into zones(city_id, name, boundary, status)
      values (
        ${city},
        'غير نشطة',
        ST_SetSRID(
          ST_GeomFromGeoJSON(${JSON.stringify(square(44.3, 33.3, 44.4, 33.4))}),
          4326
        ),
        'INACTIVE'
      )
      returning id`;
    inactiveZoneId = inactive!.id;

    const [a] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    customer = a!.id;
    await h.client`insert into customer_profiles(account_id) values(${customer})`;
    const [b] = await h.client<{ id: string }[]>`insert into accounts default values returning id`;
    otherCustomer = b!.id;
    await h.client`insert into customer_profiles(account_id) values(${otherCustomer})`;

    const created = await h.client.begin((tx) =>
      h.auth.sessions.create(tx, customer, customerContext, "PHONE_OTP", undefined, "addr-test"),
    );
    token = (await h.auth.sessions.result(customer, created, customerContext))
      .access_token;
    const otherCreated = await h.client.begin((tx) =>
      h.auth.sessions.create(
        tx,
        otherCustomer,
        customerContext,
        "PHONE_OTP",
        undefined,
        "addr-other",
      ),
    );
    otherToken = (
      await h.auth.sessions.result(otherCustomer, otherCreated, customerContext)
    ).access_token;
  });

  afterAll(() => h?.close());

  const cityHeaders = (cityId = city) => ({ "X-City-Id": cityId });

  test("unauthenticated access is rejected", async () => {
    expect(
      (
        await h.app.handle(
          jsonRequest("/api/v1/mobile/customer/addresses", {
            headers: cityHeaders(),
          }),
        )
      ).status,
    ).toBe(401);
  });

  test("missing City context follows existing behavior", async () => {
    expect(
      (
        await h.app.handle(
          jsonRequest("/api/v1/mobile/customer/addresses", { token }),
        )
      ).status,
    ).toBe(400);
  });

  test("OpenAPI documents Customer auth, X-City-Id, location, and computed Zone fields", async () => {
    const response = await h.app.handle(
      new Request("http://localhost/openapi/json"),
    );
    expect(response.status).toBe(200);
    const doc = (await response.json()) as any;
    const paths = [
      "/api/v1/mobile/customer/addresses",
      "/api/v1/mobile/customer/addresses/{addressId}",
      "/api/v1/mobile/customer/addresses/{addressId}/default",
    ];
    for (const path of paths) expect(doc.paths[path]).toBeTruthy();
    const create = doc.paths["/api/v1/mobile/customer/addresses"].post;
    expect(create.security).toEqual([{ bearerAuth: [] }]);
    expect(
      create.parameters.some((p: any) => p.name === "X-City-Id" && p.required),
    ).toBe(true);
    const body = JSON.stringify(create.requestBody);
    expect(body).toContain("latitude");
    expect(body).toContain("longitude");
    expect(body).toContain("recipientName");
    const ok = JSON.stringify(create.responses[200]);
    expect(ok).toContain("deliveryAvailable");
    expect(ok).toContain("isDefault");
    expect(doc.tags?.some((t: any) => t.name === "Customer — Addresses")).toBe(
      true,
    );
  });

  test("creates first address as default with correct Point orientation", async () => {
    const created = await h.addresses.create(customer, city, baseBody());
    expect(created.isDefault).toBe(true);
    expect(created.deliveryAvailable).toBe(true);
    expect(created.zone).toEqual({ id: zoneId, name: zoneName });
    expect(created.location).toEqual(pointInside);

    const [row] = await h.client<
      { x: number; y: number; srid: number; gtype: string }[]
    >`select ST_X(location)::float8 as x, ST_Y(location)::float8 as y,
             ST_SRID(location) as srid, GeometryType(location) as gtype
      from customer_addresses where id = ${created.id}`;
    expect(row!.x).toBe(pointInside.longitude);
    expect(row!.y).toBe(pointInside.latitude);
    expect(row!.srid).toBe(4326);
    expect(row!.gtype).toBe("POINT");
    expect(row).not.toHaveProperty("zone_id");

    const columns = await h.client<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'customer_addresses'
        and column_name in ('zone_id','store_id','delivery_fee','delivery_available')`;
    expect(columns).toHaveLength(0);
  });

  test("second address does not replace default implicitly", async () => {
    const second = await h.addresses.create(
      customer,
      city,
      baseBody({
        label: "الدوام",
        location: pointOutside,
        landmark: null,
      }),
    );
    expect(second.isDefault).toBe(false);
    expect(second.deliveryAvailable).toBe(false);
    expect(second.zone).toBeNull();
    const list = await h.addresses.list(customer, city);
    expect(list.data.filter((a) => a.isDefault)).toHaveLength(1);
    expect(list.data.find((a) => a.isDefault)?.label).toBe("البيت");
  });

  test("address outside ACTIVE Zones can be saved and remains readable", async () => {
    const listed = await h.addresses.list(customer, city);
    const outside = listed.data.find((a) => a.label === "الدوام");
    expect(outside?.deliveryAvailable).toBe(false);
    expect(outside?.zone).toBeNull();
  });

  test("inactive Zone does not make an Address deliverable", async () => {
    const insideInactive = await h.addresses.create(
      customer,
      city,
      baseBody({
        label: "منطقة غير نشطة",
        location: { latitude: 33.35, longitude: 44.35 },
      }),
    );
    expect(insideInactive.deliveryAvailable).toBe(false);
    expect(insideInactive.zone).toBeNull();
    expect(inactiveZoneId).toBeTruthy();
  });

  test("rejects invalid coordinates and empty required text", async () => {
    await expect(
      h.addresses.create(
        customer,
        city,
        baseBody({ location: { latitude: 91, longitude: 44 } }),
      ),
    ).rejects.toMatchObject({ publicCode: "INVALID_ZONE_INPUT" });
    await expect(
      h.addresses.create(
        customer,
        city,
        baseBody({ location: { latitude: 33, longitude: 200 } }),
      ),
    ).rejects.toMatchObject({ publicCode: "INVALID_ZONE_INPUT" });
    await expect(
      h.addresses.create(customer, city, baseBody({ label: "   " })),
    ).rejects.toMatchObject({ publicCode: "VALIDATION_FAILED" });
    await expect(
      h.addresses.create(customer, city, baseBody({ addressDetails: "" })),
    ).rejects.toMatchObject({ publicCode: "VALIDATION_FAILED" });
  });

  test("optional recipient fields normalize phone", async () => {
    const withRecipient = await h.addresses.create(
      customer,
      city,
      baseBody({
        label: "بيت الوالدة",
        recipientName: "أحمد",
        recipientPhone: "+964 770 111 2233",
      }),
    );
    expect(withRecipient.recipientName).toBe("أحمد");
    expect(withRecipient.recipientPhone).toBe("+9647701112233");
  });

  test("Customer sees only own addresses; body cannot override identity/city", async () => {
    const response = await h.app.handle(
      jsonRequest("/api/v1/mobile/customer/addresses", {
        method: "POST",
        token,
        headers: cityHeaders(),
        body: {
          ...baseBody({ label: "محاولة تجاوز" }),
          customerAccountId: otherCustomer,
          cityId: city2,
          zoneId,
          deliveryAvailable: true,
          isDefault: true,
        },
      }),
    );
    // Elysia strips unknown keys (same as Cart); auth + X-City-Id remain authoritative.
    expect(response.status).toBe(200);
    const created = (await response.json()) as {
      id: string;
      isDefault: boolean;
      deliveryAvailable: boolean;
      zone: { id: string } | null;
    };
    const [row] = await h.client<
      { customer_account_id: string; city_id: string; is_default: boolean }[]
    >`select customer_account_id::text, city_id::text, is_default
      from customer_addresses where id = ${created.id}`;
    expect(row!.customer_account_id).toBe(customer);
    expect(row!.city_id).toBe(city);
    // Client isDefault/deliveryAvailable/zoneId must not authoritatively force state.
    expect(created.isDefault).toBe(false);
    expect(row!.is_default).toBe(false);

    const mine = await h.addresses.list(customer, city);
    const theirs = await h.addresses.list(otherCustomer, city);
    expect(theirs.data).toHaveLength(0);
    expect(mine.data.some((a) => a.id === created.id)).toBe(true);

    const foreign = await h.addresses.create(
      otherCustomer,
      city,
      baseBody({ label: "عنوان آخر" }),
    );
    await expect(
      h.addresses.get(customer, city, foreign.id),
    ).rejects.toMatchObject({ publicCode: "ADDRESS_NOT_FOUND" });
    expect(
      (
        await h.app.handle(
          jsonRequest(`/api/v1/mobile/customer/addresses/${foreign.id}`, {
            token,
            headers: cityHeaders(),
          }),
        )
      ).status,
    ).toBe(404);
  });

  test("cross-City address ID is hidden as not found", async () => {
    const inCity2 = await h.addresses.create(
      customer,
      city2,
      baseBody({
        label: "مدينة أخرى",
        location: pointOutside,
      }),
    );
    await expect(
      h.addresses.get(customer, city, inCity2.id),
    ).rejects.toMatchObject({ publicCode: "ADDRESS_NOT_FOUND" });
    expect(
      (
        await h.app.handle(
          jsonRequest(`/api/v1/mobile/customer/addresses/${inCity2.id}`, {
            token,
            headers: cityHeaders(city),
          }),
        )
      ).status,
    ).toBe(404);
    expect(inCity2.isDefault).toBe(true);
  });

  test("list resolves Zones without N+1 zone table scans per address", async () => {
    h.trackedQueries!.length = 0;
    const list = await h.addresses.list(customer, city);
    expect(list.data.length).toBeGreaterThan(1);
    const zoneScans = h.trackedQueries!.filter(
      (q) =>
        /from\s+zones\b/i.test(q) &&
        !/lateral/i.test(q) &&
        !/customer_addresses/i.test(q),
    );
    expect(zoneScans.length).toBe(0);
    const lateral = h.trackedQueries!.filter((q) =>
      /join\s+lateral/i.test(q),
    );
    expect(lateral.length).toBe(1);
  });

  test("Zone boundary/status changes recompute availability without mutating the address", async () => {
    const target = (await h.addresses.list(customer, city)).data.find(
      (a) => a.label === "الدوام",
    )!;
    expect(target.deliveryAvailable).toBe(false);

    await h.client`
      update zones set boundary = ST_SetSRID(
        ST_GeomFromGeoJSON(${JSON.stringify(square(9, 9, 11, 11))}),
        4326
      ) where id = ${zoneId}`;
    let refreshed = await h.addresses.get(customer, city, target.id);
    expect(refreshed.deliveryAvailable).toBe(true);
    expect(refreshed.zone?.id).toBe(zoneId);

    await h.client`update zones set status = 'INACTIVE' where id = ${zoneId}`;
    refreshed = await h.addresses.get(customer, city, target.id);
    expect(refreshed.deliveryAvailable).toBe(false);
    expect(refreshed.zone).toBeNull();

    await h.client`
      update zones set status = 'ACTIVE', boundary = ST_SetSRID(
        ST_GeomFromGeoJSON(${JSON.stringify(square(44.1, 33.1, 44.2, 33.2))}),
        4326
      ) where id = ${zoneId}`;
  });

  test("boundary point follows ST_Covers semantics", async () => {
    const onBoundary = await h.addresses.create(
      customer,
      city,
      baseBody({
        label: "حد المنطقة",
        location: { latitude: 33.1, longitude: 44.1 },
      }),
    );
    expect(onBoundary.deliveryAvailable).toBe(true);
    expect(onBoundary.zone?.id).toBe(zoneId);
  });

  test("set default switches atomically and is idempotent", async () => {
    const list = await h.addresses.list(customer, city);
    const currentDefault = list.data.find((a) => a.isDefault)!;
    const other = list.data.find((a) => !a.isDefault)!;
    const switched = await h.addresses.setDefault(customer, city, other.id);
    expect(switched.isDefault).toBe(true);
    const after = await h.addresses.list(customer, city);
    expect(after.data.filter((a) => a.isDefault)).toHaveLength(1);
    expect(after.data.find((a) => a.isDefault)?.id).toBe(other.id);
    expect(after.data.find((a) => a.id === currentDefault.id)?.isDefault).toBe(
      false,
    );

    const again = await h.addresses.setDefault(customer, city, other.id);
    expect(again.isDefault).toBe(true);
    expect(
      (await h.addresses.list(customer, city)).data.filter((a) => a.isDefault),
    ).toHaveLength(1);
  });

  test("different Cities may independently have defaults", async () => {
    const inCity = (await h.addresses.list(customer, city)).data.find(
      (a) => a.isDefault,
    )!;
    const inCity2 = (await h.addresses.list(customer, city2)).data.find(
      (a) => a.isDefault,
    )!;
    expect(inCity.isDefault).toBe(true);
    expect(inCity2.isDefault).toBe(true);
    expect(inCity.id).not.toBe(inCity2.id);
  });

  test("update editable fields, clear nullables, and move location", async () => {
    const target = (await h.addresses.list(customer, city)).data.find(
      (a) => a.label === "حد المنطقة",
    )!;
    let updated = await h.addresses.update(customer, city, target.id, {
      label: "مكتب",
      addressDetails: "تفاصيل جديدة",
      landmark: null,
      recipientName: "سارة",
      recipientPhone: "+9647709998877",
      location: pointOutside,
    });
    expect(updated.label).toBe("مكتب");
    expect(updated.addressDetails).toBe("تفاصيل جديدة");
    expect(updated.landmark).toBeNull();
    expect(updated.recipientName).toBe("سارة");
    expect(updated.recipientPhone).toBe("+9647709998877");
    expect(updated.deliveryAvailable).toBe(false);
    expect(updated.zone).toBeNull();

    updated = await h.addresses.update(customer, city, target.id, {
      location: pointInside,
      recipientName: null,
      recipientPhone: null,
    });
    expect(updated.deliveryAvailable).toBe(true);
    expect(updated.zone?.id).toBe(zoneId);
    expect(updated.recipientName).toBeNull();
    expect(updated.recipientPhone).toBeNull();

    const [row] = await h.client<
      { customer_account_id: string; city_id: string }[]
    >`select customer_account_id::text, city_id::text from customer_addresses where id = ${target.id}`;
    expect(row!.customer_account_id).toBe(customer);
    expect(row!.city_id).toBe(city);
  });

  test("delete non-default preserves default; delete default picks oldest remaining", async () => {
    // Ensure deterministic set: create A then B then C dedicated for this test customer scope.
    const [tempAccount] = await h.client<{ id: string }[]>`
      insert into accounts default values returning id`;
    const tempCustomer = tempAccount!.id;
    await h.client`insert into customer_profiles(account_id) values(${tempCustomer})`;

    const first = await h.addresses.create(
      tempCustomer,
      city,
      baseBody({ label: "أولاً", location: pointOutside }),
    );
    const second = await h.addresses.create(
      tempCustomer,
      city,
      baseBody({ label: "ثانياً", location: pointOutside }),
    );
    const third = await h.addresses.create(
      tempCustomer,
      city,
      baseBody({ label: "ثالثاً", location: pointOutside }),
    );
    expect(first.isDefault).toBe(true);

    await h.addresses.remove(tempCustomer, city, second.id);
    expect(
      (await h.addresses.list(tempCustomer, city)).data.find((a) => a.isDefault)
        ?.id,
    ).toBe(first.id);

    await h.addresses.remove(tempCustomer, city, first.id);
    const remaining = await h.addresses.list(tempCustomer, city);
    expect(remaining.data).toHaveLength(1);
    expect(remaining.data[0]!.id).toBe(third.id);
    expect(remaining.data[0]!.isDefault).toBe(true);

    await h.addresses.remove(tempCustomer, city, third.id);
    expect((await h.addresses.list(tempCustomer, city)).data).toHaveLength(0);
  });

  test("other Customer/City cannot delete an address", async () => {
    const target = (await h.addresses.list(customer, city)).data[0]!;
    await expect(
      h.addresses.remove(otherCustomer, city, target.id),
    ).rejects.toMatchObject({ publicCode: "ADDRESS_NOT_FOUND" });
    await expect(
      h.addresses.remove(customer, city2, target.id),
    ).rejects.toMatchObject({ publicCode: "ADDRESS_NOT_FOUND" });
    expect(
      (
        await h.app.handle(
          jsonRequest(`/api/v1/mobile/customer/addresses/${target.id}`, {
            method: "DELETE",
            token: otherToken,
            headers: cityHeaders(),
          }),
        )
      ).status,
    ).toBe(404);
  });

  test("database partial unique index rejects duplicate defaults", async () => {
    const again = await h.addresses.list(customer, city);
    let target = again.data.find((a) => !a.isDefault);
    if (!target) {
      target = await h.addresses.create(
        customer,
        city,
        baseBody({ label: "إضافي للقيد", location: pointOutside }),
      );
    }
    let rejected = false;
    try {
      await h.client`
        update customer_addresses set is_default = true where id = ${target.id}`;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(
      (
        await h.client<{ count: number }[]>`
          select count(*)::int as count from customer_addresses
          where customer_account_id = ${customer}
            and city_id = ${city}
            and is_default = true`
      )[0]!.count,
    ).toBe(1);
  });

  test("20 addresses allowed; 21st rejected; limit is per City", async () => {
    const [limitAccount] = await h.client<{ id: string }[]>`
      insert into accounts default values returning id`;
    const limitCustomer = limitAccount!.id;
    await h.client`insert into customer_profiles(account_id) values(${limitCustomer})`;

    for (let i = 0; i < MAX_ADDRESSES_PER_CUSTOMER_CITY; i++) {
      await h.addresses.create(
        limitCustomer,
        city,
        baseBody({
          label: `عنوان ${i}`,
          location: pointOutside,
          landmark: null,
        }),
      );
    }
    await expect(
      h.addresses.create(
        limitCustomer,
        city,
        baseBody({ label: "زيادة", location: pointOutside }),
      ),
    ).rejects.toMatchObject({ publicCode: "ADDRESS_LIMIT_EXCEEDED" });

    const city2Address = await h.addresses.create(
      limitCustomer,
      city2,
      baseBody({ label: "مدينة مستقلة", location: pointOutside }),
    );
    expect(city2Address.isDefault).toBe(true);
    expect(
      (await h.addresses.list(limitCustomer, city)).data,
    ).toHaveLength(MAX_ADDRESSES_PER_CUSTOMER_CITY);
  });

  test("concurrent creates cannot exceed 20", async () => {
    const [raceAccount] = await h.client<{ id: string }[]>`
      insert into accounts default values returning id`;
    const raceCustomer = raceAccount!.id;
    await h.client`insert into customer_profiles(account_id) values(${raceCustomer})`;

    for (let i = 0; i < MAX_ADDRESSES_PER_CUSTOMER_CITY - 1; i++) {
      await h.addresses.create(
        raceCustomer,
        city,
        baseBody({ label: `race-${i}`, location: pointOutside }),
      );
    }

    const outcomes = await Promise.allSettled([
      h.addresses.create(
        raceCustomer,
        city,
        baseBody({ label: "race-a", location: pointOutside }),
      ),
      h.addresses.create(
        raceCustomer,
        city,
        baseBody({ label: "race-b", location: pointOutside }),
      ),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      publicCode: "ADDRESS_LIMIT_EXCEEDED",
    });
    expect(
      (await h.addresses.list(raceCustomer, city)).data,
    ).toHaveLength(MAX_ADDRESSES_PER_CUSTOMER_CITY);
  });

  test("concurrent set-default preserves a single default", async () => {
    const list = await h.addresses.list(customer, city);
    const a = list.data[0]!;
    const b = list.data[1]!;
    await Promise.all([
      h.addresses.setDefault(customer, city, a.id),
      h.addresses.setDefault(customer, city, b.id),
    ]);
    const defaults = (await h.addresses.list(customer, city)).data.filter(
      (x) => x.isDefault,
    );
    expect(defaults).toHaveLength(1);
    expect([a.id, b.id]).toContain(defaults[0]!.id);
  });

  test("HTTP create/list/get/patch/default/delete round-trip", async () => {
    const createRes = await h.app.handle(
      jsonRequest("/api/v1/mobile/customer/addresses", {
        method: "POST",
        token,
        headers: cityHeaders(city2),
        body: baseBody({
          label: "HTTP",
          location: pointOutside,
          landmark: "قريب",
        }),
      }),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; isDefault: boolean };
    // city2 already had a default from earlier; this may be non-default
    expect(created.id).toBeTruthy();

    const listRes = await h.app.handle(
      jsonRequest("/api/v1/mobile/customer/addresses", {
        token,
        headers: cityHeaders(city2),
      }),
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { data: { id: string }[] };
    expect(listed.data.some((a) => a.id === created.id)).toBe(true);

    const patchRes = await h.app.handle(
      jsonRequest(`/api/v1/mobile/customer/addresses/${created.id}`, {
        method: "PATCH",
        token,
        headers: cityHeaders(city2),
        body: { landmark: null },
      }),
    );
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { landmark: null }).landmark).toBeNull();

    const defaultRes = await h.app.handle(
      jsonRequest(
        `/api/v1/mobile/customer/addresses/${created.id}/default`,
        {
          method: "PATCH",
          token,
          headers: cityHeaders(city2),
        },
      ),
    );
    expect(defaultRes.status).toBe(200);
    expect(((await defaultRes.json()) as { isDefault: boolean }).isDefault).toBe(
      true,
    );

    const deleteRes = await h.app.handle(
      jsonRequest(`/api/v1/mobile/customer/addresses/${created.id}`, {
        method: "DELETE",
        token,
        headers: cityHeaders(city2),
      }),
    );
    expect(deleteRes.status).toBe(200);
    expect(((await deleteRes.json()) as { deleted: boolean }).deleted).toBe(
      true,
    );
  });

  test("no GiST index on address location; ownership indexes and one-default exist", async () => {
    const indexes = await h.client<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes where tablename = 'customer_addresses'`;
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain("customer_addresses_one_default_uidx");
    expect(names).toContain("customer_addresses_customer_city_created_idx");
    expect(
      indexes.some((i) => /using gist/i.test(i.indexdef)),
    ).toBe(false);
  });
});
