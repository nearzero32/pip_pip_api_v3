import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

const password = "fixed staff password";

const pngBytes = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
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
const nameTranslations = (name: string) => [
  { locale: "ar", name },
  { locale: "en", name: `EN ${name}` },
];
const productTranslations = (name: string) => [
  { locale: "ar", name },
  { locale: "en", name: `EN ${name}` },
];

describe("Public Product Catalog", () => {
  let harness: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let storeA = "";
  let storeA2 = "";
  let storeB = "";
  let catActive = "";
  let catEmpty = "";
  let catInactive = "";
  let productAvailable = "";
  let productUnavailable = "";
  let productArchived = "";
  let productInactiveCat = "";
  let productOtherStore = "";

  const login = (email: string, requestId: string) =>
    harness.auth.dashboard.login({
      email,
      password,
      deviceName: requestId,
      ip: requestId,
      requestId,
    });

  const createReadyAsset = async (
    token: string,
    purpose: "CATEGORY_IMAGE" | "STORE_LOGO" | "PRODUCT_IMAGE",
    fileName: string,
    city: string,
  ) => {
    const intent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: purpose === "CATEGORY_IMAGE" ? superToken : token,
        body: {
          purpose,
          ...(purpose === "CATEGORY_IMAGE" ? { cityId: city } : {}),
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
    harness.mediaStorage.putObject(objectKey!, "image/png", pngBytes);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${body.asset.id}/confirm${purpose === "CATEGORY_IMAGE" ? `?cityId=${city}` : ""}`, {
            method: "POST",
            token: purpose === "CATEGORY_IMAGE" ? superToken : token,
          }),
        )
      ).status,
    ).toBe(200);
    return body.asset.id;
  };

  const createStore = async (
    token: string,
    city: string,
    name: string,
    phone: string,
    orderAcceptanceStatus: "ACCEPTING" | "PAUSED" = "ACCEPTING",
  ) => {
    const n = Number(phone.slice(-4));
    const west = (city === cityB ? 50 : 40) + n * 0.2;
    const south = (city === cityB ? 30 : 20) + n * 0.2;
    const zone = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", {
        method: "POST",
        token: superToken,
        body: {
          cityId: city,
          translations: nameTranslations(`PZ-${phone.slice(-4)}`),
          boundary: square(west, south, west + 0.1, south + 0.1),
        },
      }),
    );
    expect(zone.status).toBe(200);
    const zoneId = ((await zone.json()) as { id: string }).id;
    const main = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/main-categories", {
        method: "POST",
        token: superToken,
        body: {
          cityId: city,
          translations: nameTranslations(`م-${phone.slice(-4)}`),
          imageAssetId: await createReadyAsset(
            token,
            "CATEGORY_IMAGE",
            `${phone}.png`,
            city,
          ),
          status: "ACTIVE",
          displayOrder: 1,
        },
      }),
    );
    expect(main.status).toBe(200);
    const mainId = ((await main.json()) as { id: string }).id;
    const sub = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/subcategories", {
        method: "POST",
        token,
        body: {
          mainCategoryId: mainId,
          translations: nameTranslations(`ف-${phone.slice(-4)}`),
          status: "ACTIVE",
          displayOrder: 1,
        },
      }),
    );
    expect(sub.status).toBe(200);
    const subId = ((await sub.json()) as { id: string }).id;
    const store = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/stores", {
        method: "POST",
        token,
        body: {
          mainCategoryId: mainId,
          translations: [
            { locale: "ar", name, address: "عنوان" },
            { locale: "en", name: `EN ${name}`, address: "EN عنوان" },
          ],
          phone,
          latitude: south + 0.02,
          longitude: west + 0.02,
          logoAssetId: await createReadyAsset(
            token,
            "STORE_LOGO",
            `l-${phone}.png`,
            city,
          ),
          zoneIds: [zoneId],
          subcategoryIds: [subId],
          status: "ACTIVE",
          orderAcceptanceStatus,
        },
      }),
    );
    expect(store.status).toBe(200);
    return ((await store.json()) as { id: string }).id;
  };

  const createCategory = async (
    storeId: string,
    name: string,
    status: "ACTIVE" | "INACTIVE" = "ACTIVE",
  ) => {
    const response = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeId}/categories`, {
        method: "POST",
        token: adminToken,
        body: { translations: nameTranslations(name), status, displayOrder: 1 },
      }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { id: string }).id;
  };

  const createProduct = async (
    storeId: string,
    name: string,
    extras: Record<string, unknown> = {},
  ) => {
    const imageAssetId = await createReadyAsset(
      adminToken,
      "PRODUCT_IMAGE",
      `${name}.png`,
      cityA,
    );
    const response = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeId}/products`, {
        method: "POST",
        token: adminToken,
        body: {
          translations: productTranslations(name),
          basePrice: 2500,
          images: [{ assetId: imageAssetId, isPrimary: true, displayOrder: 0 }],
          ...extras,
        },
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      id: string;
      isAvailable: boolean;
      basePrice: number;
    };
  };

  const publicGet = (path: string, city = cityA, language?: string) =>
    harness.app.handle(
      jsonRequest(path, { headers: { "X-City-Id": city, ...(language ? { "Accept-Language": language } : {}) } }),
    );

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_public_catalog",
    });
    cityA = await createActiveCity(harness.client, "Pub Cat City A");
    cityB = await createActiveCity(harness.client, "Pub Cat City B");
    await createStaffAccount(harness.auth, harness.client, {
      email: "pub-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "pub-admin@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "pub-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    superToken = (await login("pub-super@example.com", "super")).access_token;
    adminToken = (await login("pub-admin@example.com", "admin")).access_token;
    adminBToken = (await login("pub-admin-b@example.com", "admin-b"))
      .access_token;

    storeA = await createStore(
      adminToken,
      cityA,
      "متجر عام",
      "+9647709900001",
      "PAUSED",
    );
    storeA2 = await createStore(
      adminToken,
      cityA,
      "متجر عام ٢",
      "+9647709900002",
    );
    storeB = await createStore(
      adminBToken,
      cityB,
      "متجر مدينة ب",
      "+9647709900003",
    );

    catActive = await createCategory(storeA, "مشروبات");
    catEmpty = await createCategory(storeA, "فارغ");
    catInactive = await createCategory(storeA, "مخفي", "INACTIVE");

    productAvailable = (
      await createProduct(storeA, "عصير برتقال", {
        categoryId: catActive,
        displayOrder: 2,
      })
    ).id;
    productUnavailable = (
      await createProduct(storeA, "عصير تفاح", {
        categoryId: catActive,
        isAvailable: false,
        displayOrder: 1,
      })
    ).id;
    productArchived = (
      await createProduct(storeA, "منتج مؤرشف", { categoryId: catActive })
    ).id;
    expect(
      (
        await harness.app.handle(
          jsonRequest(
            `/api/v1/dashboard/stores/${storeA}/products/${productArchived}`,
            { method: "DELETE", token: adminToken },
          ),
        )
      ).status,
    ).toBe(200);

    productInactiveCat = (
      await createProduct(storeA, "تحت تصنيف مخفي", {
        categoryId: catInactive,
      })
    ).id;

    const otherImage = await createReadyAsset(
      adminToken,
      "PRODUCT_IMAGE",
      "other.png",
      cityA,
    );
    const other = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA2}/products`, {
        method: "POST",
        token: adminToken,
        body: {
          translations: productTranslations("منتج متجر آخر"),
          basePrice: 1000,
          images: [{ assetId: otherImage, isPrimary: true }],
        },
      }),
    );
    expect(other.status).toBe(200);
    productOtherStore = ((await other.json()) as { id: string }).id;

    const group = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/modifier-groups`, {
        method: "POST",
        token: adminToken,
        body: {
          translations: nameTranslations("إضافات عامة"),
          minSelect: 0,
          maxSelect: 2,
          options: [
            { translations: nameTranslations("ثلج"), displayOrder: 0 },
            { translations: nameTranslations("نعناع"), displayOrder: 1 },
          ],
        },
      }),
    );
    expect(group.status).toBe(200);
    const groupBody = (await group.json()) as {
      id: string;
      options: { id: string; name: string }[];
    };
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/products/${productAvailable}`,
        {
          method: "PATCH",
          token: adminToken,
          body: { modifierGroupId: groupBody.id },
        },
      ),
    );
    const ice = groupBody.options.find((o) => o.name === "ثلج")!;
    const mint = groupBody.options.find((o) => o.name === "نعناع")!;
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/products/${productAvailable}/modifiers/${ice.id}`,
        {
          method: "PUT",
          token: adminToken,
          body: { price: 0, isAvailable: true, maxQuantity: 1 },
        },
      ),
    );
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/products/${productAvailable}/modifiers/${mint.id}`,
        {
          method: "PUT",
          token: adminToken,
          body: { price: 500, isAvailable: false, maxQuantity: 1 },
        },
      ),
    );
  }, 120000);

  afterAll(async () => {
    await harness.close();
  });

  test("no login required; X-City-Id enforced; PAUSED store browseable", async () => {
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/public/stores/${storeA}/products`),
        )
      ).status,
    ).toBe(400);

    const store = await publicGet(`/api/v1/public/stores/${storeA}`);
    expect(store.status).toBe(200);
    const storeBody = (await store.json()) as {
      orderAcceptanceStatus: string;
      isAcceptingOrders: boolean;
    };
    expect(storeBody.orderAcceptanceStatus).toBe("PAUSED");
    expect(storeBody.isAcceptingOrders).toBe(false);

    const list = await publicGet(`/api/v1/public/stores/${storeA}/products`);
    expect(list.status).toBe(200);
  });

  test("categories: ACTIVE with products visible; empty/inactive/archived hidden", async () => {
    const response = await publicGet(
      `/api/v1/public/stores/${storeA}/categories`,
    );
    expect(response.status).toBe(200);
    const ids = (
      (await response.json()) as { data: { id: string; name: string }[] }
    ).data.map((row) => row.id);
    expect(ids).toContain(catActive);
    expect(ids).not.toContain(catEmpty);
    expect(ids).not.toContain(catInactive);

    await createProduct(storeA, "يملأ الفارغ", { categoryId: catEmpty });
    const after = await publicGet(
      `/api/v1/public/stores/${storeA}/categories`,
    );
    const afterIds = (
      (await after.json()) as { data: { id: string }[] }
    ).data.map((row) => row.id);
    expect(afterIds).toContain(catEmpty);
  });

  test("product list visibility, order, pagination, search, category filter", async () => {
    const list = await publicGet(
      `/api/v1/public/stores/${storeA}/products?limit=10`,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: {
        id: string;
        name: string;
        isAvailable: boolean;
        isOrderable: boolean;
        price: number;
        primaryImage: { url: string | null } | null;
      }[];
      total: number;
      page: number;
      limit: number;
    };
    const ids = body.data.map((row) => row.id);
    expect(ids).toContain(productAvailable);
    expect(ids).toContain(productUnavailable);
    expect(ids).not.toContain(productArchived);
    expect(ids).not.toContain(productInactiveCat);
    expect(ids).not.toContain(productOtherStore);

    const unavailable = body.data.find((row) => row.id === productUnavailable)!;
    expect(unavailable.isAvailable).toBe(false);
    expect(unavailable.isOrderable).toBe(false);
    const available = body.data.find((row) => row.id === productAvailable)!;
    expect(available.isAvailable).toBe(true);
    expect(available.isOrderable).toBe(true);
    expect(available.price).toBe(2500);
    expect(available.primaryImage?.url).toBeTruthy();

    const english = await publicGet(
      `/api/v1/public/stores/${storeA}/products?search=EN%20عصير%20برتقال`,
      cityA,
      "en",
    );
    const englishAvailable = ((await english.json()) as {
      data: Array<{ id: string; name: string; resolvedLocale: string }>;
    }).data.find((row) => row.id === productAvailable);
    expect(englishAvailable).toMatchObject({
      name: "EN عصير برتقال",
      resolvedLocale: "en",
    });

    // displayOrder: unavailable(1) before available(2)
    const idxUnavail = body.data.findIndex((r) => r.id === productUnavailable);
    const idxAvail = body.data.findIndex((r) => r.id === productAvailable);
    expect(idxUnavail).toBeLessThan(idxAvail);

    const page1 = await publicGet(
      `/api/v1/public/stores/${storeA}/products?page=1&limit=1`,
    );
    const page1Body = (await page1.json()) as {
      data: { id: string }[];
      total: number;
      limit: number;
    };
    expect(page1Body.data).toHaveLength(1);
    expect(page1Body.limit).toBe(1);
    expect(page1Body.total).toBeGreaterThanOrEqual(2);

    const search = await publicGet(
      `/api/v1/public/stores/${storeA}/products?search=برتقال`,
    );
    const searchIds = (
      (await search.json()) as { data: { id: string }[] }
    ).data.map((r) => r.id);
    expect(searchIds).toEqual([productAvailable]);

    const searchCase = await publicGet(
      `/api/v1/public/stores/${storeA}/products?search=عصير`,
    );
    expect(
      ((await searchCase.json()) as { data: unknown[] }).data.length,
    ).toBeGreaterThanOrEqual(2);

    const hiddenSearch = await publicGet(
      `/api/v1/public/stores/${storeA}/products?search=مؤرشف`,
    );
    expect(
      ((await hiddenSearch.json()) as { data: unknown[] }).data,
    ).toHaveLength(0);

    const byCat = await publicGet(
      `/api/v1/public/stores/${storeA}/products?categoryId=${catActive}`,
    );
    const byCatIds = (
      (await byCat.json()) as { data: { id: string }[] }
    ).data.map((r) => r.id);
    expect(byCatIds).toContain(productAvailable);
    expect(byCatIds).not.toContain(productInactiveCat);

    expect(
      (
        await errorOf(
          await publicGet(
            `/api/v1/public/stores/${storeA}/products?categoryId=${catInactive}`,
          ),
        )
      ).code,
    ).toBe("STORE_CATEGORY_NOT_FOUND");

    expect(
      (
        await errorOf(
          await publicGet(
            `/api/v1/public/stores/${storeA}/products?categoryId=${crypto.randomUUID()}`,
          ),
        )
      ).code,
    ).toBe("STORE_CATEGORY_NOT_FOUND");
  });

  test("product details, modifiers, isolation", async () => {
    const detail = await publicGet(
      `/api/v1/public/stores/${storeA}/products/${productAvailable}`,
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      id: string;
      price: number;
      isOrderable: boolean;
      store: { orderAcceptanceStatus: string };
      images: { displayOrder: number }[];
      modifiers: {
        group: { id: string } | null;
        options: {
          isAvailable: boolean;
          isSelectable: boolean;
          price: number;
        }[];
      };
    };
    expect(body.price).toBe(2500);
    expect(body.isOrderable).toBe(true);
    expect(body.store.orderAcceptanceStatus).toBe("PAUSED");
    expect(body.images.length).toBeGreaterThanOrEqual(1);
    expect(body.modifiers.group).not.toBeNull();
    expect(body.modifiers.options).toHaveLength(2);
    expect(
      body.modifiers.options.some(
        (o) => o.isAvailable === false && o.isSelectable === false,
      ),
    ).toBe(true);
    expect(
      body.modifiers.options.some(
        (o) => o.isAvailable === true && o.price === 0,
      ),
    ).toBe(true);

    const unavailDetail = await publicGet(
      `/api/v1/public/stores/${storeA}/products/${productUnavailable}`,
    );
    expect(unavailDetail.status).toBe(200);
    expect(
      ((await unavailDetail.json()) as { isOrderable: boolean }).isOrderable,
    ).toBe(false);

    expect(
      (
        await errorOf(
          await publicGet(
            `/api/v1/public/stores/${storeA}/products/${productArchived}`,
          ),
        )
      ).code,
    ).toBe("PRODUCT_NOT_FOUND");
    expect(
      (
        await errorOf(
          await publicGet(
            `/api/v1/public/stores/${storeA}/products/${productInactiveCat}`,
          ),
        )
      ).code,
    ).toBe("PRODUCT_NOT_FOUND");
    expect(
      (
        await errorOf(
          await publicGet(
            `/api/v1/public/stores/${storeA2}/products/${productAvailable}`,
          ),
        )
      ).code,
    ).toBe("PRODUCT_NOT_FOUND");
    expect(
      (
        await errorOf(
          await publicGet(
            `/api/v1/public/stores/${storeA}/products/${productAvailable}`,
            cityB,
          ),
        )
      ).code,
    ).toBe("STORE_NOT_FOUND");
    expect(
      (
        await errorOf(
          await publicGet(
            `/api/v1/public/stores/${storeB}/products/${productAvailable}`,
            cityB,
          ),
        )
      ).code,
    ).toBe("PRODUCT_NOT_FOUND");
  });
});
