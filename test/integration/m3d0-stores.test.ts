import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  tokenClaims,
  type IntegrationHarness,
} from "./helpers";

const password = "fixed staff password";

const pngBytes = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59,
  0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
);

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

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error;
const translationsFor = (name: string, address = "بغداد - الكرادة") => [
  { locale: "ar", name, address },
  { locale: "en", name: `EN ${name}`, address: `EN ${address}` },
];

const login = async (
  harness: IntegrationHarness,
  email: string,
  requestId: string,
) =>
  harness.auth.dashboard.login({
    email,
    password,
    deviceName: requestId,
    ip: requestId,
    requestId,
  });

const grant = async (
  harness: IntegrationHarness,
  adminToken: string,
  employeeId: string,
  permissions: string[],
) => {
  for (const permission of permissions) {
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/employees/${employeeId}/permissions`, {
            method: "POST",
            token: adminToken,
            body: { permission },
          }),
        )
      ).status,
    ).toBe(200);
  }
};

describe("M3-D0 Stores, service zones & working hours", () => {
  let harness: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let employeeId = "";
  let employeeToken = "";
  let adminAccountId = "";
  let mainA = "";
  let mainA2 = "";
  let mainB = "";
  let subA1 = "";
  let subA2 = "";
  let subA2fromMain2 = "";
  let subB = "";
  let zoneA1 = "";
  let zoneA2 = "";
  let zoneB = "";

  const createReadyAsset = async (
    token: string,
    purpose: "CATEGORY_IMAGE" | "STORE_LOGO" | "STORE_IMAGE",
    fileName: string,
  ) => {
    const city = token === adminBToken ? cityB : cityA;
    const categoryImage = purpose === "CATEGORY_IMAGE";
    const intent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: categoryImage ? superToken : token,
        body: {
          purpose,
          ...(categoryImage ? { cityId: city } : {}),
          fileName,
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    expect(intent.status).toBe(200);
    const body = (await intent.json()) as { asset: { id: string } };
    const objectKey = await harness.media.getObjectKeyForTests(
      body.asset.id,
      city,
    );
    expect(objectKey).toBeTruthy();
    harness.mediaStorage.putObject(objectKey!, "image/png", pngBytes);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${body.asset.id}/confirm${categoryImage ? `?cityId=${city}` : ""}`, {
            method: "POST",
            token: categoryImage ? superToken : token,
          }),
        )
      ).status,
    ).toBe(200);
    return body.asset.id;
  };

  const createZone = async (
    token: string,
    name: string,
    boundary: ReturnType<typeof square>,
  ) => {
    const response = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", {
        method: "POST",
        token: superToken,
        body: { cityId: token === adminBToken ? cityB : cityA, translations: [{ locale: "ar", name }, { locale: "en", name: `EN ${name}` }], boundary },
      }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { id: string }).id;
  };

  const createMain = async (
    token: string,
    name: string,
    displayOrder = 1,
  ) => {
    const response = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/main-categories", {
        method: "POST",
        token: superToken,
        body: {
          cityId: token === adminBToken ? cityB : cityA,
          translations: [{ locale: "ar", name }, { locale: "en", name: `EN ${name}` }],
          imageAssetId: await createReadyAsset(
            token,
            "CATEGORY_IMAGE",
            `${name}.png`,
          ),
          status: "ACTIVE",
          displayOrder,
        },
      }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { id: string }).id;
  };

  const createSub = async (
    token: string,
    mainCategoryId: string,
    name: string,
  ) => {
    const response = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/subcategories", {
        method: "POST",
        token,
        body: { mainCategoryId, translations: [{ locale: "ar", name }, { locale: "en", name: `EN ${name}` }], status: "ACTIVE", displayOrder: 1 },
      }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { id: string }).id;
  };

  const baseStoreBody = async (
    overrides: Record<string, unknown> = {},
    token = adminToken,
  ) => {
    const { name, address, translations, ...rest } = overrides;
    const resolvedName = typeof name === "string" ? name : "متجر تجريبي";
    const resolvedAddress = typeof address === "string" ? address : "بغداد - الكرادة";
    return {
    mainCategoryId: mainA,
    translations: translations ?? translationsFor(resolvedName, resolvedAddress),
    phone: "+9647700000001",
    latitude: 33.15,
    longitude: 44.15,
    logoAssetId: await createReadyAsset(token, "STORE_LOGO", "logo.png"),
    zoneIds: [zoneA1],
    subcategoryIds: [subA1],
    status: "ACTIVE",
    orderAcceptanceStatus: "ACCEPTING",
    workingHours: [
      { dayOfWeek: "WEDNESDAY", opensAt: "09:00", closesAt: "23:00" },
      { dayOfWeek: "THURSDAY", opensAt: "09:00", closesAt: "23:00" },
      { dayOfWeek: "FRIDAY", opensAt: "09:00", closesAt: "23:00" },
      { dayOfWeek: "SATURDAY", opensAt: "18:00", closesAt: "02:00" },
      { dayOfWeek: "SUNDAY", opensAt: "09:00", closesAt: "17:00" },
      { dayOfWeek: "MONDAY", opensAt: "09:00", closesAt: "17:00" },
      { dayOfWeek: "TUESDAY", opensAt: "09:00", closesAt: "17:00" },
    ],
    ...rest,
    };
  };

  const createStore = async (
    token: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const body = await baseStoreBody(overrides, token);
    return harness.app.handle(
      jsonRequest("/api/v1/dashboard/stores", {
        method: "POST",
        token,
        body,
      }),
    );
  };

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_m3d0",
    });
    cityA = await createActiveCity(harness.client, "Store City A");
    cityB = await createActiveCity(harness.client, "Store City B");

    await createStaffAccount(harness.auth, harness.client, {
      email: "m3d0-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    adminAccountId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3d0-admin@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "m3d0-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    employeeId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3d0-emp@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });

    superToken = (await login(harness, "m3d0-super@example.com", "super"))
      .access_token;
    adminToken = (await login(harness, "m3d0-admin@example.com", "admin"))
      .access_token;
    adminBToken = (await login(harness, "m3d0-admin-b@example.com", "admin-b"))
      .access_token;

    await grant(harness, adminToken, employeeId, [
      "media.read",
      "media.create",
      "media.delete",
      "subcategories.read",
      "subcategories.create",
      "stores.read",
      "stores.create",
      "stores.update",
      "stores.archive",
    ]);
    employeeToken = (await login(harness, "m3d0-emp@example.com", "emp"))
      .access_token;

    zoneA1 = await createZone(adminToken, "Zone A1", square(44.1, 33.1, 44.2, 33.2));
    zoneA2 = await createZone(adminToken, "Zone A2", square(44.3, 33.3, 44.4, 33.4));
    zoneB = await createZone(adminBToken, "Zone B", square(45.1, 34.1, 45.2, 34.2));

    mainA = await createMain(adminToken, "مطاعم", 1);
    mainA2 = await createMain(adminToken, "حلويات", 2);
    mainB = await createMain(adminBToken, "مطاعم ب", 1);
    subA1 = await createSub(adminToken, mainA, "برغر");
    subA2 = await createSub(adminToken, mainA, "بيتزا");
    subA2fromMain2 = await createSub(adminToken, mainA2, "كيك");
    subB = await createSub(adminBToken, mainB, "برغر ب");
  });

  afterAll(async () => {
    await harness.close();
  });

  test("dashboard city comes from signed token and create rejects cityId", async () => {
    const claims = tokenClaims(adminToken);
    expect(claims.cityId).toBe(cityA);
    const response = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/stores", {
        method: "POST",
        token: adminToken,
        body: {
          ...(await baseStoreBody()),
          cityId: cityB,
        },
      }),
    );
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("VALIDATION_FAILED");
  });

  test("SUPER_ADMIN is blocked from Store operations", async () => {
    const body = await baseStoreBody(
      { name: "سوبر", phone: "+9647700000088" },
      adminToken,
    );
    const response = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/stores", {
        method: "POST",
        token: superToken,
        body,
      }),
    );
    expect(response.status).toBe(403);
  });

  test("SUPER_ADMIN uses the explicit-city Store route while Admin remains forbidden", async () => {
    const allowed = await harness.app.handle(
      jsonRequest(`/api/v1/super-admin/stores?cityId=${cityA}`, {
        token: superToken,
      }),
    );
    expect(allowed.status).toBe(200);

    const create = await harness.app.handle(
      jsonRequest('/api/v1/super-admin/stores', {
        method: 'POST',
        token: superToken,
        body: { ...(await baseStoreBody({ name: 'متجر سوبر', phone: '+9647700000044' })), cityId: cityA },
      }),
    );
    expect(create.status).toBe(200);
    expect(((await create.json()) as { name: string }).name).toBe('متجر سوبر');

    const missingCity = await harness.app.handle(
      jsonRequest("/api/v1/super-admin/stores", { token: superToken }),
    );
    expect(missingCity.status).toBe(422);
    expect((await errorOf(missingCity)).code).toBe("VALIDATION_FAILED");

    const forbidden = await harness.app.handle(
      jsonRequest(`/api/v1/super-admin/stores?cityId=${cityA}`, {
        token: adminToken,
      }),
    );
    expect(forbidden.status).toBe(403);
  });

  test("employee live permission grant is required", async () => {
    const empNo = await createStaffAccount(harness.auth, harness.client, {
      email: "m3d0-emp-noperm@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });
    await grant(harness, adminToken, empNo, [
      "media.read",
      "media.create",
      "subcategories.read",
    ]);
    const withMedia = (
      await login(harness, "m3d0-emp-noperm@example.com", "emp2a")
    ).access_token;
    expect((await createStore(withMedia)).status).toBe(403);
    await grant(harness, adminToken, empNo, ["stores.create", "stores.read"]);
    const refreshed = (
      await login(harness, "m3d0-emp-noperm@example.com", "emp2b")
    ).access_token;
    const created = await createStore(refreshed, {
      name: "متجر موظف",
      phone: "+9647700000099",
    });
    expect(created.status).toBe(200);
  });

  test("creates store atomically and scopes to auth city", async () => {
    const response = await createStore(adminToken, {
      name: "متجر كامل",
      phone: "+9647700000002",
      coverAssetId: await createReadyAsset(
        adminToken,
        "STORE_IMAGE",
        "cover.png",
      ),
      zoneIds: [zoneA1, zoneA2],
      subcategoryIds: [subA1, subA2],
    });
    expect(response.status).toBe(200);
    const store = (await response.json()) as {
      id: string;
      status: string;
      zoneIds: string[];
      subcategoryIds: string[];
      cover: { assetId: string } | null;
      availability: { isOpen: boolean };
    };
    expect(store.status).toBe("ACTIVE");
    expect(store.zoneIds.sort()).toEqual([zoneA1, zoneA2].sort());
    expect(store.subcategoryIds.sort()).toEqual([subA1, subA2].sort());
    expect(store.cover).not.toBeNull();

    const [row] = await harness.client<{ city_id: string }[]>`
      select city_id::text as city_id from stores where id = ${store.id}`;
    expect(row?.city_id).toBe(cityA);
  });

  test("rejects cross-city main category, subcategory, and zone", async () => {
    expect(
      (
        await errorOf(
          await createStore(adminToken, {
            name: "رفض تصنيف",
            phone: "+9647700000010",
            mainCategoryId: mainB,
          }),
        )
      ).code,
    ).toBe("MAIN_CATEGORY_NOT_FOUND");

    expect(
      (
        await errorOf(
          await createStore(adminToken, {
            name: "رفض فرعي",
            phone: "+9647700000011",
            subcategoryIds: [subB],
          }),
        )
      ).code,
    ).toBe("SUBCATEGORY_NOT_FOUND");

    expect(
      (
        await errorOf(
          await createStore(adminToken, {
            name: "رفض منطقة",
            phone: "+9647700000012",
            zoneIds: [zoneB],
          }),
        )
      ).code,
    ).toBe("ZONE_NOT_FOUND");
  });

  test("cross-city store lookup returns 404", async () => {
    const created = await createStore(adminToken, {
      name: "عزل مدينة",
      phone: "+9647700000013",
    });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { id: string }).id;
    const foreign = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${id}`, { token: adminBToken }),
    );
    expect(foreign.status).toBe(404);
    expect((await errorOf(foreign)).code).toBe("STORE_NOT_FOUND");
  });

  test("requires subcategory under selected main category and at least one zone", async () => {
    expect(
      (
        await errorOf(
          await createStore(adminToken, {
            name: "تصنيف خاطئ",
            phone: "+9647700000014",
            subcategoryIds: [subA2fromMain2],
          }),
        )
      ).code,
    ).toBe("VALIDATION_FAILED");

    const noZone = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/stores", {
        method: "POST",
        token: adminToken,
        body: {
          ...(await baseStoreBody({ name: "بدون منطقة", phone: "+9647700000015" })),
          zoneIds: [],
        },
      }),
    );
    expect([422, 400]).toContain(noZone.status);
  });

  test("rejects archived subcategory assignment and archived main category", async () => {
    const archivedSub = await createSub(adminToken, mainA, "مؤرشف");
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/subcategories/${archivedSub}`, {
            method: "DELETE",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await errorOf(
          await createStore(adminToken, {
            name: "فرعي مؤرشف",
            phone: "+9647700000016",
            subcategoryIds: [archivedSub],
          }),
        )
      ).code,
    ).toBe("SUBCATEGORY_NOT_FOUND");
  });

  test("physical location must be inside an active city zone via ST_Covers", async () => {
    expect(
      (
        await errorOf(
          await createStore(adminToken, {
            name: "خارج المناطق",
            phone: "+9647700000017",
            latitude: 10,
            longitude: 10,
          }),
        )
      ).code,
    ).toBe("INVALID_STORE_LOCATION");

    // Boundary point of zoneA1 west/south corner — ST_Covers includes boundary
    const onBoundary = await createStore(adminToken, {
      name: "على الحدود",
      phone: "+9647700000018",
      latitude: 33.1,
      longitude: 44.1,
    });
    expect(onBoundary.status).toBe(200);
  });

  test("service coverage is independent from physical store location", async () => {
    // Physically in zoneA1, serves only zoneA2
    const created = await createStore(adminToken, {
      name: "تغطية مستقلة",
      phone: "+9647700000019",
      latitude: 33.15,
      longitude: 44.15,
      zoneIds: [zoneA2],
    });
    expect(created.status).toBe(200);
    const store = (await created.json()) as { id: string; zoneIds: string[] };
    expect(store.zoneIds).toEqual([zoneA2]);

    const inA1 = await harness.app.handle(
      jsonRequest(`/api/v1/public/stores?zoneId=${zoneA1}`, {
        headers: { "x-city-id": cityA },
      }),
    );
    expect(inA1.status).toBe(200);
    const listA1 = (await inA1.json()) as { data: { id: string }[] };
    expect(listA1.data.some((row) => row.id === store.id)).toBe(false);

    const inA2 = await harness.app.handle(
      jsonRequest(`/api/v1/public/stores?zoneId=${zoneA2}`, {
        headers: { "x-city-id": cityA },
      }),
    );
    const listA2 = (await inA2.json()) as { data: { id: string }[] };
    expect(listA2.data.some((row) => row.id === store.id)).toBe(true);
  });

  test("media claim, replace, cover removal, and archive release", async () => {
    const logo1 = await createReadyAsset(adminToken, "STORE_LOGO", "l1.png");
    const cover1 = await createReadyAsset(adminToken, "STORE_IMAGE", "c1.png");
    const created = await createStore(adminToken, {
      name: "وسائط",
      phone: "+9647700000020",
      logoAssetId: logo1,
      coverAssetId: cover1,
    });
    expect(created.status).toBe(200);
    const store = (await created.json()) as { id: string };

    const [attachedLogo] = await harness.client<
      { attached_at: Date | string | null; status: string }[]
    >`select attached_at, status::text as status from media_assets where id = ${logo1}`;
    expect(attachedLogo?.attached_at).not.toBeNull();
    expect(attachedLogo?.status).toBe("READY");

    const logo2 = await createReadyAsset(adminToken, "STORE_LOGO", "l2.png");
    const patched = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${store.id}`, {
        method: "PATCH",
        token: adminToken,
        body: { logoAssetId: logo2, coverAssetId: null },
      }),
    );
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as {
      logo: { assetId: string };
      cover: null;
    };
    expect(after.logo.assetId).toBe(logo2);
    expect(after.cover).toBeNull();

    const [releasedCover] = await harness.client<{ status: string }[]>`
      select status::text as status from media_assets where id = ${cover1}`;
    expect(releasedCover?.status).toBe("DELETE_PENDING");

    const archived = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${store.id}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    expect(archived.status).toBe(200);
    const [releasedLogo] = await harness.client<{ status: string }[]>`
      select status::text as status from media_assets where id = ${logo2}`;
    expect(releasedLogo?.status).toBe("DELETE_PENDING");
    const [row] = await harness.client<
      { status: string; logo: string | null; cover: string | null }[]
    >`select status::text as status, logo_asset_id::text as logo, cover_asset_id::text as cover
      from stores where id = ${store.id}`;
    expect(row?.status).toBe("ARCHIVED");
    expect(row?.logo).toBeNull();
    expect(row?.cover).toBeNull();
  });

  test("main category change replaces subcategory set atomically", async () => {
    const created = await createStore(adminToken, {
      name: "تغيير تصنيف",
      phone: "+9647700000021",
      subcategoryIds: [subA1],
    });
    const id = ((await created.json()) as { id: string }).id;
    const bad = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { mainCategoryId: mainA2 },
      }),
    );
    expect(bad.status).toBe(422);

    const ok = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: {
          mainCategoryId: mainA2,
          subcategoryIds: [subA2fromMain2],
        },
      }),
    );
    expect(ok.status).toBe(200);
    const store = (await ok.json()) as {
      mainCategory: { id: string };
      subcategoryIds: string[];
    };
    expect(store.mainCategory.id).toBe(mainA2);
    expect(store.subcategoryIds).toEqual([subA2fromMain2]);
  });

  test("rejects overlapping working hours", async () => {
    expect(
      (
        await errorOf(
          await createStore(adminToken, {
            name: "تداخل ساعات",
            phone: "+9647700000022",
            workingHours: [
              { dayOfWeek: "MONDAY", opensAt: "09:00", closesAt: "14:00" },
              { dayOfWeek: "MONDAY", opensAt: "13:00", closesAt: "18:00" },
            ],
          }),
        )
      ).code,
    ).toBe("WORKING_HOURS_OVERLAP");
  });

  test("public visibility matrix for schedule and status", async () => {
    const openStore = await createStore(adminToken, {
      name: "مفتوح",
      phone: "+9647700000030",
      status: "ACTIVE",
      orderAcceptanceStatus: "ACCEPTING",
      workingHours: [
        { dayOfWeek: "MONDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "TUESDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "WEDNESDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "THURSDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "FRIDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "SATURDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "SUNDAY", opensAt: "00:00", closesAt: "23:59" },
      ],
    });
    const openId = ((await openStore.json()) as { id: string }).id;

    const paused = await createStore(adminToken, {
      name: "موقوف",
      phone: "+9647700000031",
      status: "ACTIVE",
      orderAcceptanceStatus: "PAUSED",
      workingHours: [
        { dayOfWeek: "MONDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "TUESDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "WEDNESDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "THURSDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "FRIDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "SATURDAY", opensAt: "00:00", closesAt: "23:59" },
        { dayOfWeek: "SUNDAY", opensAt: "00:00", closesAt: "23:59" },
      ],
    });
    const pausedId = ((await paused.json()) as { id: string }).id;

    const closedHours = await createStore(adminToken, {
      name: "مغلق جدول",
      phone: "+9647700000032",
      status: "ACTIVE",
      workingHours: [],
    });
    const closedId = ((await closedHours.json()) as { id: string }).id;

    const draft = await createStore(adminToken, {
      name: "مسودة",
      phone: "+9647700000033",
      status: "DRAFT",
    });
    const draftId = ((await draft.json()) as { id: string }).id;

    const inactive = await createStore(adminToken, {
      name: "غير نشط",
      phone: "+9647700000034",
      status: "INACTIVE",
    });
    const inactiveId = ((await inactive.json()) as { id: string }).id;

    const toArchive = await createStore(adminToken, {
      name: "للأرشفة",
      phone: "+9647700000035",
    });
    const archivedId = ((await toArchive.json()) as { id: string }).id;
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/stores/${archivedId}`, {
            method: "DELETE",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);

    // Force known schedule evaluation via service for closed store nextOpening
    const forced = await harness.stores.listPublic(cityA, {
      zoneId: zoneA1,
      now: new Date("2026-08-05T09:00:00+03:00"),
    });
    const closedForced = forced.data.find((row: { id: string }) => row.id === closedId);
    expect(closedForced).toBeTruthy();
    expect(closedForced.isOpen).toBe(false);
    expect(closedForced.isAcceptingOrders).toBe(false);

    const list = await harness.app.handle(
      jsonRequest(`/api/v1/public/stores?zoneId=${zoneA1}`, {
        headers: { "x-city-id": cityA },
      }),
    );
    expect(list.status).toBe(200);
    const data = ((await list.json()) as { data: { id: string; isOpen: boolean; isAcceptingOrders: boolean }[] })
      .data;
    const byId = Object.fromEntries(data.map((row) => [row.id, row]));

    expect(byId[openId]?.isAcceptingOrders).toBe(true);
    expect(byId[pausedId]?.isOpen).toBe(true);
    expect(byId[pausedId]?.isAcceptingOrders).toBe(false);
    expect(byId[closedId]).toBeTruthy();
    expect(byId[closedId]?.isOpen).toBe(false);
    expect(byId[closedId]?.isAcceptingOrders).toBe(false);
    expect(byId[draftId]).toBeUndefined();
    expect(byId[inactiveId]).toBeUndefined();
    expect(byId[archivedId]).toBeUndefined();

    const english = await harness.app.handle(
      jsonRequest(`/api/v1/public/stores?zoneId=${zoneA1}`, {
        headers: { "x-city-id": cityA, "accept-language": "en" },
      }),
    );
    const englishOpen = ((await english.json()) as {
      data: Array<{ id: string; name: string; address: string; resolvedLocale: string }>;
    }).data.find((row) => row.id === openId);
    expect(englishOpen).toMatchObject({
      name: "EN مفتوح",
      address: "EN بغداد - الكرادة",
      resolvedLocale: "en",
    });
  });

  test("employee can create with granted stores.create", async () => {
    const response = await createStore(employeeToken, {
      name: "موظف مخول",
      phone: "+9647700000040",
    });
    expect(response.status).toBe(200);
  });

  test("duplicate store_zones relationship is impossible at DB level", async () => {
    const created = await createStore(adminToken, {
      name: "تكرار منطقة",
      phone: "+9647700000041",
      zoneIds: [zoneA1],
    });
    const id = ((await created.json()) as { id: string }).id;
    let rejected = false;
    try {
      await harness.client`
        insert into store_zones (store_id, zone_id, city_id)
        values (${id}, ${zoneA1}, ${cityA})`;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
