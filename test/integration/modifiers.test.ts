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
const translationsFor = (name: string) => [
  { locale: "ar", name },
  { locale: "en", name: `EN ${name}` },
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

describe("Modifier Groups / Options / ProductModifierOption", () => {
  let harness: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let employeeToken = "";
  let storeA = "";
  let storeB = "";

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
          translations: translationsFor(`MZ-${phone.slice(-4)}`),
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
          translations: translationsFor(`تصنيف-${phone.slice(-4)}`),
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
          translations: translationsFor(`فرعي-${phone.slice(-4)}`),
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

  const createProduct = async (token: string, storeId: string, name: string) => {
    const res = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeId}/products`, {
        method: "POST",
        token,
        body: {
          translations: translationsFor(name),
          basePrice: 5000,
          images: [
            {
              assetId: await createReadyAsset(
                token,
                "PRODUCT_IMAGE",
                `${crypto.randomUUID()}.png`,
              ),
              isPrimary: true,
              displayOrder: 0,
            },
          ],
        },
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      id: string;
      modifierGroupId: string | null;
      isAvailable: boolean;
      status: string;
    };
  };

  const createGroup = (
    token: string,
    storeId: string,
    body: Record<string, unknown>,
  ) => {
    const { name, options, ...rest } = body;
    return harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeId}/modifier-groups`, {
        method: "POST",
        token,
        body: {
          ...rest,
          ...(typeof name === "string" ? { translations: translationsFor(name) } : {}),
          ...(Array.isArray(options) ? { options: options.map((option) => {
            const input = option as Record<string, unknown>;
            const { name: optionName, ...optionRest } = input;
            return { ...optionRest, ...(typeof optionName === "string" ? { translations: translationsFor(optionName) } : {}) };
          }) } : {}),
        },
      }),
    );
  };

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_modifiers",
    });
    cityA = await createActiveCity(harness.client, "Mod City A");
    cityB = await createActiveCity(harness.client, "Mod City B");

    await createStaffAccount(harness.auth, harness.client, {
      email: "mod-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    const adminAccountId = await createStaffAccount(
      harness.auth,
      harness.client,
      {
        email: "mod-admin@example.com",
        password,
        roles: ["ADMIN"],
        cityId: cityA,
      },
    );
    await createStaffAccount(harness.auth, harness.client, {
      email: "mod-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    const employeeId = await createStaffAccount(harness.auth, harness.client, {
      email: "mod-emp@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });

    superToken = (await login(harness, "mod-super@example.com", "super"))
      .access_token;
    adminToken = (await login(harness, "mod-admin@example.com", "admin"))
      .access_token;
    adminBToken = (await login(harness, "mod-admin-b@example.com", "admin-b"))
      .access_token;

    await grant(harness, adminToken, employeeId, [
      "media.read",
      "media.create",
      "products.read",
      "products.create",
      "products.update",
      "modifiers.read",
      "modifiers.create",
      "modifiers.update",
      "modifiers.archive",
    ]);
    employeeToken = (await login(harness, "mod-emp@example.com", "emp"))
      .access_token;

    storeA = await createStore(adminToken, "متجر معدّلات", "+9647703000001");
    storeB = await createStore(adminBToken, "متجر ب", "+9647703000002");
  });

  afterAll(async () => {
    await harness.close();
  });

  test("product without group; create group with options; reject empty/duplicates", async () => {
    const product = await createProduct(adminToken, storeA, "برغر عادي");
    expect(product.modifierGroupId).toBeNull();

    expect(
      (
        await errorOf(
          await createGroup(adminToken, storeA, {
            name: "فارغ",
            minSelect: 0,
            maxSelect: 1,
            options: [],
          }),
        )
      ).code,
    ).toBe("VALIDATION_FAILED");

    const created = await createGroup(adminToken, storeA, {
      name: "إضافات برغر",
      minSelect: 0,
      maxSelect: 3,
      options: [
        { name: "جبنة إضافية", displayOrder: 0 },
        { name: "لحم إضافي", displayOrder: 1 },
      ],
    });
    expect(created.status).toBe(200);
    const group = (await created.json()) as {
      id: string;
      options: { id: string; name: string }[];
    };
    expect(group.options).toHaveLength(2);

    expect(
      (
        await errorOf(
          await createGroup(adminToken, storeA, {
            name: "  إضافات برغر  ",
            minSelect: 0,
            maxSelect: 1,
            options: [{ name: "مخلل" }],
          }),
        )
      ).code,
    ).toBe("MODIFIER_GROUP_NAME_CONFLICT");

    const otherCity = await createGroup(adminBToken, storeB, {
      name: "إضافات برغر",
      minSelect: 0,
      maxSelect: 1,
      options: [{ name: "جبنة إضافية" }],
    });
    expect(otherCity.status).toBe(200);

    expect(
      (
        await errorOf(
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/stores/${storeA}/modifier-groups/${group.id}/options`,
              {
                method: "POST",
                token: adminToken,
                body: { translations: translationsFor(" جبنة إضافية ") },
              },
            ),
          ),
        )
      ).code,
    ).toBe("MODIFIER_OPTION_NAME_CONFLICT");
  });

  test("invalid select/price/default/maxQuantity rules", async () => {
    expect(
      (
        await errorOf(
          await createGroup(adminToken, storeA, {
            name: "حدود خاطئة",
            minSelect: 5,
            maxSelect: 2,
            options: [{ name: "خيار حدود" }],
          }),
        )
      ).code,
    ).toBe("INVALID_MODIFIER_SELECT");

    const groupRes = await createGroup(adminToken, storeA, {
      name: "مجموعة أسعار",
      minSelect: 0,
      maxSelect: 2,
      options: [
        { name: "صلصة أ", displayOrder: 0 },
        { name: "صلصة ب", displayOrder: 1 },
      ],
    });
    const group = (await groupRes.json()) as {
      id: string;
      options: { id: string }[];
    };
    const product = await createProduct(adminToken, storeA, "برغر أسعار");
    expect(
      (
        await harness.app.handle(
          jsonRequest(
            `/api/v1/dashboard/stores/${storeA}/products/${product.id}`,
            {
              method: "PATCH",
              token: adminToken,
              body: { modifierGroupId: group.id },
            },
          ),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await errorOf(
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/stores/${storeA}/products/${product.id}/modifiers/${group.options[0]!.id}`,
              {
                method: "PUT",
                token: adminToken,
                body: { price: -1, maxQuantity: 1 },
              },
            ),
          ),
        )
      ).code,
    ).toBe("VALIDATION_FAILED");

    expect(
      (
        await errorOf(
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/stores/${storeA}/products/${product.id}/modifiers/${group.options[0]!.id}`,
              {
                method: "PUT",
                token: adminToken,
                body: { price: 0, isDefault: true, maxQuantity: 0 },
              },
            ),
          ),
        )
      ).code,
    ).toBe("INVALID_MAX_QUANTITY");

    expect(
      (
        await errorOf(
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/stores/${storeA}/products/${product.id}/modifiers/${group.options[0]!.id}`,
              {
                method: "PUT",
                token: adminToken,
                body: { price: 500, isDefault: true, maxQuantity: 1 },
              },
            ),
          ),
        )
      ).code,
    ).toBe("INVALID_MODIFIER_DEFAULT_PRICE");

    expect(
      (
        await harness.app.handle(
          jsonRequest(
            `/api/v1/dashboard/stores/${storeA}/products/${product.id}/modifiers/${group.options[0]!.id}`,
            {
              method: "PUT",
              token: adminToken,
              body: { price: 0, isDefault: true, maxQuantity: 1 },
            },
          ),
        )
      ).status,
    ).toBe(200);
  });

  test("group switch preserves configs; new option not auto-activated; no leak", async () => {
    const groupA = (await (
      await createGroup(adminToken, storeA, {
        name: "مجموعة أ",
        minSelect: 0,
        maxSelect: 2,
        options: [
          { name: "خيار أ1", displayOrder: 0 },
          { name: "خيار أ2", displayOrder: 1 },
        ],
      })
    ).json()) as { id: string; options: { id: string; name: string }[] };

    const groupB = (await (
      await createGroup(adminToken, storeA, {
        name: "مجموعة ب",
        minSelect: 0,
        maxSelect: 2,
        options: [{ name: "خيار ب1", displayOrder: 0 }],
      })
    ).json()) as { id: string; options: { id: string }[] };

    const product = await createProduct(adminToken, storeA, "برغر تبديل");
    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/products/${product.id}`, {
        method: "PATCH",
        token: adminToken,
        body: { modifierGroupId: groupA.id },
      }),
    );
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/products/${product.id}/modifiers/${groupA.options[0]!.id}`,
        {
          method: "PUT",
          token: adminToken,
          body: { price: 1000, isAvailable: true, isDefault: false, maxQuantity: 2 },
        },
      ),
    );

    const addJalapeno = await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/modifier-groups/${groupA.id}/options`,
        {
          method: "POST",
          token: adminToken,
          body: { translations: translationsFor("هالابينو"), displayOrder: 2 },
        },
      ),
    );
    expect(addJalapeno.status).toBe(200);
    const withJal = (await addJalapeno.json()) as {
      options: { id: string; name: string }[];
    };
    const jal = withJal.options.find((o) => o.name === "هالابينو")!;

    let mods = (await (
      await harness.app.handle(
        jsonRequest(
          `/api/v1/dashboard/stores/${storeA}/products/${product.id}/modifiers`,
          { token: adminToken },
        ),
      )
    ).json()) as { options: { modifierOptionId: string }[] };
    expect(mods.options.map((o) => o.modifierOptionId)).toEqual([
      groupA.options[0]!.id,
    ]);
    expect(mods.options.some((o) => o.modifierOptionId === jal.id)).toBe(false);

    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/products/${product.id}`, {
        method: "PATCH",
        token: adminToken,
        body: { modifierGroupId: groupB.id },
      }),
    );
    mods = (await (
      await harness.app.handle(
        jsonRequest(
          `/api/v1/dashboard/stores/${storeA}/products/${product.id}/modifiers`,
          { token: adminToken },
        ),
      )
    ).json()) as { options: { modifierOptionId: string }[] };
    expect(mods.options).toHaveLength(0);

    const [preserved] = await harness.client<{ n: string }[]>`
      select count(*)::text as n from product_modifier_options
      where product_id = ${product.id}
        and modifier_option_id = ${groupA.options[0]!.id}`;
    expect(Number(preserved?.n)).toBe(1);

    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/products/${product.id}`, {
        method: "PATCH",
        token: adminToken,
        body: { modifierGroupId: groupA.id },
      }),
    );
    const restored = (await (
      await harness.app.handle(
        jsonRequest(
          `/api/v1/dashboard/stores/${storeA}/products/${product.id}/modifiers`,
          { token: adminToken },
        ),
      )
    ).json()) as {
      options: { modifierOptionId: string; price: number }[];
    };
    expect(restored.options).toHaveLength(1);
    expect(restored.options[0]!.price).toBe(1000);
  });

  test("archive/restore name conflicts; availability layers; public read", async () => {
    const groupRes = await createGroup(adminToken, storeA, {
      name: "مجموعة أرشفة",
      minSelect: 1,
      maxSelect: 3,
      options: [
        { name: "خيار مرئي", displayOrder: 0 },
        { name: "خيار مخفي", displayOrder: 1 },
      ],
    });
    const group = (await groupRes.json()) as {
      id: string;
      options: { id: string; name: string }[];
    };
    const product = await createProduct(adminToken, storeA, "برغر أرشفة");
    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA}/products/${product.id}`, {
        method: "PATCH",
        token: adminToken,
        body: { modifierGroupId: group.id },
      }),
    );
    for (const option of group.options) {
      await harness.app.handle(
        jsonRequest(
          `/api/v1/dashboard/stores/${storeA}/products/${product.id}/modifiers/${option.id}`,
          {
            method: "PUT",
            token: adminToken,
            body: {
              price: option.name === "خيار مرئي" ? 0 : 500,
              isAvailable: option.name === "خيار مرئي",
              isDefault: option.name === "خيار مرئي",
              maxQuantity: 1,
            },
          },
        ),
      );
    }

    const otherProduct = await createProduct(adminToken, storeA, "برغر آخر");
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/products/${otherProduct.id}`,
        {
          method: "PATCH",
          token: adminToken,
          body: { modifierGroupId: group.id },
        },
      ),
    );
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/products/${otherProduct.id}/modifiers/${group.options[0]!.id}`,
        {
          method: "PUT",
          token: adminToken,
          body: { price: 0, isAvailable: true, isDefault: false, maxQuantity: 1 },
        },
      ),
    );

    expect(
      (
        await harness.app.handle(
          jsonRequest(
            `/api/v1/dashboard/stores/${storeA}/modifier-groups/${group.id}/options/${group.options[1]!.id}`,
            { method: "DELETE", token: adminToken },
          ),
        )
      ).status,
    ).toBe(200);

    const [pmoStill] = await harness.client<{ n: string }[]>`
      select count(*)::text as n from product_modifier_options
      where product_id = ${product.id}
        and modifier_option_id = ${group.options[1]!.id}`;
    expect(Number(pmoStill?.n)).toBe(1);

    const productAfter = (await (
      await harness.app.handle(
        jsonRequest(
          `/api/v1/dashboard/stores/${storeA}/products/${product.id}`,
          { token: adminToken },
        ),
      )
    ).json()) as { status: string; isAvailable: boolean };
    expect(productAfter.status).toBe("ACTIVE");
    expect(productAfter.isAvailable).toBe(true);

    expect(
      (
        await harness.app.handle(
          jsonRequest(
            `/api/v1/dashboard/stores/${storeA}/modifier-groups/${group.id}`,
            { method: "DELETE", token: adminToken },
          ),
        )
      ).status,
    ).toBe(200);

    const publicEmpty = await harness.app.handle(
      jsonRequest(
        `/api/v1/public/stores/${storeA}/products/${product.id}/modifiers`,
        { headers: { "X-City-Id": cityA } },
      ),
    );
    expect(publicEmpty.status).toBe(200);
    expect(
      ((await publicEmpty.json()) as { group: null; options: unknown[] }).group,
    ).toBeNull();

    await createGroup(adminToken, storeA, {
      name: "مجموعة أرشفة",
      minSelect: 0,
      maxSelect: 1,
      options: [{ name: "بديل اسم" }],
    });
    expect(
      (
        await errorOf(
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/stores/${storeA}/modifier-groups/${group.id}/restore`,
              { method: "POST", token: adminToken },
            ),
          ),
        )
      ).code,
    ).toBe("MODIFIER_GROUP_NAME_CONFLICT");

    const group2 = (await (
      await createGroup(adminToken, storeA, {
        name: "مجموعة استعادة خيار",
        minSelect: 0,
        maxSelect: 1,
        options: [{ name: "خيار للاستعادة" }],
      })
    ).json()) as { id: string; options: { id: string }[] };
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/modifier-groups/${group2.id}/options/${group2.options[0]!.id}`,
        { method: "DELETE", token: adminToken },
      ),
    );
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/modifier-groups/${group2.id}/options`,
        {
          method: "POST",
          token: adminToken,
          body: { translations: translationsFor("خيار للاستعادة") },
        },
      ),
    );
    expect(
      (
        await errorOf(
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/stores/${storeA}/modifier-groups/${group2.id}/options/${group2.options[0]!.id}/restore`,
              { method: "POST", token: adminToken },
            ),
          ),
        )
      ).code,
    ).toBe("MODIFIER_OPTION_NAME_CONFLICT");

    // Product-specific availability isolation + public filter
    const group3 = (await (
      await createGroup(adminToken, storeA, {
        name: "مجموعة عامة",
        minSelect: 0,
        maxSelect: 2,
        options: [
          { name: "جبن عام", displayOrder: 1 },
          { name: "صلصة عامة", displayOrder: 0 },
        ],
      })
    ).json()) as { id: string; options: { id: string; name: string }[] };
    const cheese = group3.options.find((o) => o.name === "جبن عام")!;
    const sauce = group3.options.find((o) => o.name === "صلصة عامة")!;
    const p1 = await createProduct(adminToken, storeA, "برغر عام ١");
    const p2 = await createProduct(adminToken, storeA, "برغر عام ٢");
    for (const p of [p1, p2]) {
      await harness.app.handle(
        jsonRequest(`/api/v1/dashboard/stores/${storeA}/products/${p.id}`, {
          method: "PATCH",
          token: adminToken,
          body: { modifierGroupId: group3.id },
        }),
      );
    }
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/products/${p1.id}/modifiers/${cheese.id}`,
        {
          method: "PUT",
          token: adminToken,
          body: { price: 1000, isAvailable: false, maxQuantity: 1 },
        },
      ),
    );
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/products/${p1.id}/modifiers/${sauce.id}`,
        {
          method: "PUT",
          token: adminToken,
          body: { price: 0, isAvailable: true, maxQuantity: 1 },
        },
      ),
    );
    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/products/${p2.id}/modifiers/${cheese.id}`,
        {
          method: "PUT",
          token: adminToken,
          body: { price: 1500, isAvailable: true, maxQuantity: 3 },
        },
      ),
    );

    const pub1 = (await (
      await harness.app.handle(
        jsonRequest(
          `/api/v1/public/stores/${storeA}/products/${p1.id}/modifiers`,
          { headers: { "X-City-Id": cityA } },
        ),
      )
    ).json()) as {
      options: {
        modifierOptionId: string;
        displayOrder: number;
        isAvailable: boolean;
        isSelectable: boolean;
      }[];
    };
    expect(pub1.options.map((o) => o.modifierOptionId)).toEqual([
      sauce.id,
      cheese.id,
    ]);
    expect(pub1.options[0]!.displayOrder).toBe(0);
    expect(pub1.options[0]!.isAvailable).toBe(true);
    expect(pub1.options[1]!.isAvailable).toBe(false);
    expect(pub1.options[1]!.isSelectable).toBe(false);

    const pub2 = (await (
      await harness.app.handle(
        jsonRequest(
          `/api/v1/public/stores/${storeA}/products/${p2.id}/modifiers`,
          { headers: { "X-City-Id": cityA } },
        ),
      )
    ).json()) as {
      options: {
        modifierOptionId: string;
        price: number;
        isAvailable: boolean;
      }[];
    };
    expect(pub2.options).toHaveLength(1);
    expect(pub2.options[0]!.price).toBe(1500);
    expect(pub2.options[0]!.isAvailable).toBe(true);

    await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/stores/${storeA}/modifier-groups/${group3.id}/options/${sauce.id}`,
        {
          method: "PATCH",
          token: adminToken,
          body: { isAvailable: false },
        },
      ),
    );
    const pub1b = (await (
      await harness.app.handle(
        jsonRequest(
          `/api/v1/public/stores/${storeA}/products/${p1.id}/modifiers`,
          { headers: { "X-City-Id": cityA } },
        ),
      )
    ).json()) as {
      options: { modifierOptionId: string; isAvailable: boolean }[];
    };
    expect(pub1b.options).toHaveLength(2);
    expect(pub1b.options.every((o) => o.isAvailable === false)).toBe(true);
  });

  test("city isolation, SUPER_ADMIN blocked, employee grants, concurrent name uniqueness", async () => {
    expect(
      (
        await createGroup(superToken, storeA, {
          name: "ممنوع",
          minSelect: 0,
          maxSelect: 1,
          options: [{ name: "ممنوع خيار" }],
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/stores/${storeA}/modifier-groups`, {
            token: adminBToken,
          }),
        )
      ).status,
    ).toBe(404);

    const empCreate = await createGroup(employeeToken, storeA, {
      name: "مجموعة موظف",
      minSelect: 0,
      maxSelect: 1,
      options: [{ name: "خيار موظف" }],
    });
    expect(empCreate.status).toBe(200);

    const results = await Promise.all(
      [1, 2].map((i) =>
        createGroup(adminToken, storeA, {
          name: "اسم متزامن",
          minSelect: 0,
          maxSelect: 1,
          options: [{ name: `خيار متزامن ${i}` }],
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toContain(200);
    expect(statuses).toContain(409);
  });
});
