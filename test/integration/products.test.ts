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
const nameTranslations = (name: string) => [
  { locale: "ar", name },
  { locale: "en", name: `EN ${name}` },
];
const productTranslations = (name: string, description?: string) => [
  { locale: "ar", name, ...(description === undefined ? {} : { description }) },
  { locale: "en", name: `EN ${name}`, ...(description === undefined ? {} : { description: `EN ${description}` }) },
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

describe("Store Products dashboard management", () => {
  let harness: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let employeeToken = "";
  let adminAccountId = "";
  let storeA = "";
  let storeB = "";
  let catMain = "";
  let catSub = "";
  let catOther = "";

  const createReadyAsset = async (
    token: string,
    purpose: "CATEGORY_IMAGE" | "STORE_LOGO" | "PRODUCT_IMAGE",
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

  const createStore = async (token: string, name: string, phone: string) => {
    const n = Number(phone.slice(-4));
    const west = (token === adminBToken ? 50 : 40) + n * 0.2;
    const south = (token === adminBToken ? 30 : 20) + n * 0.2;
    const zone = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", {
        method: "POST",
        token: superToken,
        body: {
          cityId: token === adminBToken ? cityB : cityA,
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
          cityId: token === adminBToken ? cityB : cityA,
          translations: nameTranslations(`تصنيف-${phone.slice(-4)}`),
          imageAssetId: await createReadyAsset(
            token,
            "CATEGORY_IMAGE",
            `${phone}-mc.png`,
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
          translations: nameTranslations(`فرعي-${phone.slice(-4)}`),
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
          ),
          zoneIds: [zoneId],
          subcategoryIds: [subId],
          status: "ACTIVE",
        },
      }),
    );
    expect(store.status).toBe(200);
    return ((await store.json()) as { id: string }).id;
  };

  const productImage = async (token = adminToken) => ({
    assetId: await createReadyAsset(token, "PRODUCT_IMAGE", `${crypto.randomUUID()}.png`),
    isPrimary: true,
    displayOrder: 0,
  });

  const createProduct = (
    token: string,
    storeId: string,
    body: Record<string, unknown>,
  ) => {
    const { name, description, sizes, ...rest } = body;
    return harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeId}/products`, {
        method: "POST",
        token,
        body: {
          ...rest,
          ...(typeof name === "string" ? { translations: productTranslations(name, typeof description === "string" ? description : undefined) } : {}),
          ...(Array.isArray(sizes) ? { sizes: sizes.map((size) => {
            const input = size as Record<string, unknown>;
            const { name: sizeName, ...sizeRest } = input;
            return { ...sizeRest, ...(typeof sizeName === "string" ? { translations: nameTranslations(sizeName) } : {}) };
          }) } : {}),
        },
      }),
    );
  };

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_products",
    });
    cityA = await createActiveCity(harness.client, "Prod City A");
    cityB = await createActiveCity(harness.client, "Prod City B");

    await createStaffAccount(harness.auth, harness.client, {
      email: "prod-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    adminAccountId = await createStaffAccount(harness.auth, harness.client, {
      email: "prod-admin@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "prod-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    const employeeId = await createStaffAccount(harness.auth, harness.client, {
      email: "prod-emp@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });

    superToken = (await login(harness, "prod-super@example.com", "super"))
      .access_token;
    adminToken = (await login(harness, "prod-admin@example.com", "admin"))
      .access_token;
    adminBToken = (await login(harness, "prod-admin-b@example.com", "admin-b"))
      .access_token;

    await grant(harness, adminToken, employeeId, [
      "media.read",
      "media.create",
      "products.read",
      "products.create",
      "products.update",
      "products.archive",
    ]);
    employeeToken = (await login(harness, "prod-emp@example.com", "emp"))
      .access_token;

    storeA = await createStore(adminToken, "متجر منتجات", "+9647702000001");
    storeB = await createStore(adminBToken, "متجر ب", "+9647702000002");

    const mainCat = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/categories`, {
        method: "POST",
        token: adminToken,
        body: { translations: nameTranslations("برغر"), displayOrder: 1 },
      }),
    );
    expect(mainCat.status).toBe(200);
    catMain = ((await mainCat.json()) as { id: string }).id;
    const subCat = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/categories`, {
        method: "POST",
        token: adminToken,
        body: { translations: nameTranslations("دبل"), parentCategoryId: catMain, displayOrder: 1 },
      }),
    );
    expect(subCat.status).toBe(200);
    catSub = ((await subCat.json()) as { id: string }).id;
    const other = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/categories`, {
        method: "POST",
        token: adminToken,
        body: { translations: nameTranslations("مشروبات"), displayOrder: 2 },
      }),
    );
    expect(other.status).toBe(200);
    catOther = ((await other.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  test("creates uncategorized, main-category, and subcategory products", async () => {
    const plain = await createProduct(adminToken, storeA, {
      name: "منتج عادي",
      basePrice: 5000,
      images: [await productImage()],
    });
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as { categoryId: null }).categoryId).toBeNull();

    const underMain = await createProduct(adminToken, storeA, {
      name: "برغر كلاسيك",
      categoryId: catMain,
      basePrice: 8000,
      images: [await productImage()],
    });
    expect(underMain.status).toBe(200);

    const underSub = await createProduct(adminToken, storeA, {
      name: "برغر دبل",
      categoryId: catSub,
      basePrice: 12000,
      images: [await productImage()],
    });
    expect(underSub.status).toBe(200);
    expect(((await underSub.json()) as { categoryId: string }).categoryId).toBe(
      catSub,
    );
  });

  test("rejects foreign/archived category and body ownership overrides", async () => {
    const foreignCat = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeB}/categories`, {
        method: "POST",
        token: adminBToken,
        body: { translations: nameTranslations("أجنبي") },
      }),
    );
    const foreignId = ((await foreignCat.json()) as { id: string }).id;
    expect(
      (
        await errorOf(
          await createProduct(adminToken, storeA, {
            name: "رفض تصنيف",
            categoryId: foreignId,
            basePrice: 1000,
            images: [await productImage()],
          }),
        )
      ).code,
    ).toBe("STORE_CATEGORY_NOT_FOUND");

    expect(
      (
        await errorOf(
          await createProduct(adminToken, storeA, {
            name: "تجاوز",
            basePrice: 1000,
            images: [await productImage()],
            cityId: cityB,
          }),
        )
      ).code,
    ).toBe("VALIDATION_FAILED");
  });

  test("price source invariant and size transitions", async () => {
    expect(
      (
        await errorOf(
          await createProduct(adminToken, storeA, {
            name: "بدون سعر",
            images: [await productImage()],
          }),
        )
      ).code,
    ).toBe("PRODUCT_REQUIRES_PRICE");

    expect(
      (
        await errorOf(
          await createProduct(adminToken, storeA, {
            name: "سعر مع أحجام",
            basePrice: 5000,
            images: [await productImage()],
            sizes: [
              { name: "صغير", price: 4000, isDefault: true },
              { name: "كبير", price: 6000, isDefault: false },
            ],
          }),
        )
      ).code,
    ).toBe("PRODUCT_PRICE_WITH_SIZES");

    const sized = await createProduct(adminToken, storeA, {
      name: "منتج أحجام",
      images: [await productImage()],
      sizes: [
        { name: "صغير", price: 4000, isDefault: true, displayOrder: 1 },
        { name: "كبير", price: 7000, isDefault: false, displayOrder: 2 },
      ],
    });
    expect(sized.status).toBe(200);
    const sizedBody = (await sized.json()) as {
      id: string;
      basePrice: null;
      sizes: { id: string; isDefault: boolean; name: string }[];
    };
    expect(sizedBody.basePrice).toBeNull();
    expect(sizedBody.sizes.filter((s) => s.isDefault)).toHaveLength(1);

    const base = await createProduct(adminToken, storeA, {
      name: "انتقال سعر",
      basePrice: 9000,
      images: [await productImage()],
    });
    const baseId = ((await base.json()) as { id: string }).id;

    expect(
      (
        await errorOf(
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/stores/${storeA}/products/${baseId}/sizes`,
              {
                method: "POST",
                token: adminToken,
                body: { translations: nameTranslations("وسط"), price: 9500, isDefault: true },
              },
            ),
          ),
        )
      ).code,
    ).toBe("PRODUCT_PRICE_WITH_SIZES");

    const firstSize = await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/products/${baseId}/sizes`,
        {
          method: "POST",
          token: adminToken,
          body: {
            translations: nameTranslations("وسط"),
            price: 9500,
            isDefault: true,
            transitionFromBasePrice: true,
          },
        },
      ),
    );
    expect(firstSize.status).toBe(200);
    expect(
      ((await firstSize.json()) as { basePrice: null }).basePrice,
    ).toBeNull();

    const got = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/products/${baseId}`, {
        token: adminToken,
      }),
    );
    const product = (await got.json()) as {
      sizes: { id: string }[];
      basePrice: number | null;
    };
    expect(product.basePrice).toBeNull();
    const onlySizeId = product.sizes[0]!.id;

    const archiveLast = await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/products/${baseId}/sizes/${onlySizeId}`,
        {
          method: "DELETE",
          token: adminToken,
          body: { basePrice: 9100 },
        },
      ),
    );
    expect(archiveLast.status).toBe(200);
    expect(
      ((await archiveLast.json()) as { basePrice: number }).basePrice,
    ).toBe(9100);
  });

  test("images require primary, max 10, archive keeps rows", async () => {
    const img1 = await productImage();
    const created = await createProduct(adminToken, storeA, {
      name: "صور",
      basePrice: 3000,
      images: [img1],
    });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { id: string }).id;

    const tooMany = [];
    for (let i = 0; i < 11; i++) {
      tooMany.push({
        assetId: await createReadyAsset(
          adminToken,
          "PRODUCT_IMAGE",
          `m${i}.png`,
        ),
        isPrimary: i === 0,
        displayOrder: i,
      });
    }
    expect(
      (
        await errorOf(
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/stores/${storeA}/products/${id}/images`,
              {
                method: "PUT",
                token: adminToken,
                body: { images: tooMany },
              },
            ),
          ),
        )
      ).code,
    ).toBe("PRODUCT_IMAGE_LIMIT_EXCEEDED");

    const archived = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/products/${id}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    expect(archived.status).toBe(200);
    const [imgCount] = await harness.client<{ n: string }[]>`
      select count(*)::text as n from product_images where product_id = ${id}`;
    expect(Number(imgCount?.n)).toBeGreaterThanOrEqual(1);
  });

  test("availability windows and product archive leaves schedules", async () => {
    const created = await createProduct(adminToken, storeA, {
      name: "جدول",
      basePrice: 2000,
      images: [await productImage()],
      availability: [
        { dayOfWeek: "SATURDAY", opensAt: "06:00", closesAt: "11:00" },
        { dayOfWeek: "SATURDAY", opensAt: "17:00", closesAt: "22:00" },
      ],
    });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { id: string }).id;

    expect(
      (
        await errorOf(
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/stores/${storeA}/products/${id}/availability`,
              {
                method: "PUT",
                token: adminToken,
                body: {
                  windows: [
                    { dayOfWeek: "MONDAY", opensAt: "22:00", closesAt: "02:00" },
                  ],
                },
              },
            ),
          ),
        )
      ).code,
    ).toBe("INVALID_PRODUCT_AVAILABILITY");

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/stores/${storeA}/products/${id}`, {
            method: "DELETE",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);
    const [n] = await harness.client<{ n: string }[]>`
      select count(*)::text as n from product_availability_windows where product_id = ${id}`;
    expect(Number(n?.n)).toBe(2);
  });

  test("category archive cascades product archive transactionally", async () => {
    const cat = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/categories`, {
        method: "POST",
        token: adminToken,
        body: { translations: nameTranslations("إفطار") },
      }),
    );
    const categoryId = ((await cat.json()) as { id: string }).id;
    const assigned = await createProduct(adminToken, storeA, {
      name: "فطور ١",
      categoryId,
      basePrice: 4000,
      images: [await productImage()],
    });
    const assignedId = ((await assigned.json()) as { id: string }).id;
    const unrelated = await createProduct(adminToken, storeA, {
      name: "غير متعلق",
      categoryId: catOther,
      basePrice: 4000,
      images: [await productImage()],
    });
    const unrelatedId = ((await unrelated.json()) as { id: string }).id;
    const uncategorized = await createProduct(adminToken, storeA, {
      name: "بلا تصنيف",
      basePrice: 4000,
      images: [await productImage()],
    });
    const uncategorizedId = ((await uncategorized.json()) as { id: string }).id;

    expect(
      (
        await harness.app.handle(
          jsonRequest(
            `/api/v1/dashboard/stores/${storeA}/categories/${categoryId}`,
            { method: "DELETE", token: adminToken },
          ),
        )
      ).status,
    ).toBe(200);

    const [a] = await harness.client<{ status: string }[]>`
      select status::text as status from products where id = ${assignedId}`;
    const [u] = await harness.client<{ status: string }[]>`
      select status::text as status from products where id = ${unrelatedId}`;
    const [n] = await harness.client<{ status: string }[]>`
      select status::text as status from products where id = ${uncategorizedId}`;
    expect(a?.status).toBe("ARCHIVED");
    expect(u?.status).toBe("ACTIVE");
    expect(n?.status).toBe("ACTIVE");

    const [imgs] = await harness.client<{ n: string }[]>`
      select count(*)::text as n from product_images where product_id = ${assignedId}`;
    expect(Number(imgs?.n)).toBe(1);
  });

  test("city isolation, SUPER_ADMIN blocked, employee permissions", async () => {
    const created = await createProduct(adminToken, storeA, {
      name: "عزل",
      basePrice: 1500,
      images: [await productImage()],
    });
    const id = ((await created.json()) as { id: string }).id;
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/stores/${storeA}/products/${id}`, {
            token: adminBToken,
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await createProduct(superToken, storeA, {
          name: "سوبر",
          basePrice: 1500,
          images: [await productImage()],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await createProduct(employeeToken, storeA, {
          name: "موظف منتج",
          basePrice: 1600,
          images: [await productImage(employeeToken)],
        })
      ).status,
    ).toBe(200);
  });

  test("product can change category or become uncategorized; isAvailable toggles", async () => {
    const created = await createProduct(adminToken, storeA, {
      name: "تغيير تصنيف",
      categoryId: catMain,
      basePrice: 2222,
      images: [await productImage()],
    });
    const id = ((await created.json()) as { id: string }).id;
    const moved = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/products/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { categoryId: catOther, isAvailable: false },
      }),
    );
    expect(moved.status).toBe(200);
    const body = (await moved.json()) as {
      categoryId: string;
      isAvailable: boolean;
    };
    expect(body.categoryId).toBe(catOther);
    expect(body.isAvailable).toBe(false);

    const cleared = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/products/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { categoryId: null },
      }),
    );
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { categoryId: null }).categoryId).toBeNull();
  });
});
