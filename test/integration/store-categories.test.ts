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
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x02,
  0x00,
  0x00,
  0x00,
  0x90,
  0x77,
  0x53,
  0xde,
  0x00,
  0x00,
  0x00,
  0x0c,
  0x49,
  0x44,
  0x41,
  0x54,
  0x08,
  0xd7,
  0x63,
  0xf8,
  0xff,
  0xff,
  0x3f,
  0x00,
  0x05,
  0xfe,
  0x02,
  0xfe,
  0xdc,
  0xcc,
  0x59,
  0xe7,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
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

describe("Store Categories (in-store catalog)", () => {
  let harness: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let employeeId = "";
  let employeeToken = "";
  let adminAccountId = "";
  let storeA = "";
  let storeA2 = "";
  let storeB = "";

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
        body: { cityId: token === adminBToken ? cityB : cityA,
          name: `Z-${phone.slice(-4)}`,
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
        body: { cityId: token === adminBToken ? cityB : cityA,
          name: `تصنيف-${phone.slice(-4)}`,
          imageAssetId: await createReadyAsset(
            token,
            "CATEGORY_IMAGE",
            `${phone}.png`,
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
          name: `فرعي-${phone.slice(-4)}`,
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
          name,
          phone,
          address: "عنوان",
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

  const createCategory = (
    token: string,
    storeId: string,
    body: Record<string, unknown>,
  ) =>
    harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeId}/categories`, {
        method: "POST",
        token,
        body,
      }),
    );

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_store_cat",
    });
    cityA = await createActiveCity(harness.client, "Cat City A");
    cityB = await createActiveCity(harness.client, "Cat City B");

    await createStaffAccount(harness.auth, harness.client, {
      email: "scat-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    adminAccountId = await createStaffAccount(harness.auth, harness.client, {
      email: "scat-admin@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "scat-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    employeeId = await createStaffAccount(harness.auth, harness.client, {
      email: "scat-emp@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });

    superToken = (await login(harness, "scat-super@example.com", "super"))
      .access_token;
    adminToken = (await login(harness, "scat-admin@example.com", "admin"))
      .access_token;
    adminBToken = (await login(harness, "scat-admin-b@example.com", "admin-b"))
      .access_token;

    await grant(harness, adminToken, employeeId, [
      "media.read",
      "media.create",
      "subcategories.read",
      "subcategories.create",
      "stores.read",
      "stores.create",
      "store_categories.read",
      "store_categories.create",
      "store_categories.update",
      "store_categories.archive",
    ]);
    employeeToken = (await login(harness, "scat-emp@example.com", "emp"))
      .access_token;

    storeA = await createStore(adminToken, "متجر أ", "+9647701000001");
    storeA2 = await createStore(adminToken, "متجر أ٢", "+9647701000002");
    storeB = await createStore(adminBToken, "متجر ب", "+9647701000003");
  });

  afterAll(async () => {
    await harness.close();
  });

  test("creates main category and subcategory under same store", async () => {
    const main = await createCategory(adminToken, storeA, {
      name: "مشروبات",
      displayOrder: 1,
    });
    expect(main.status).toBe(200);
    const mainBody = (await main.json()) as {
      id: string;
      storeId: string;
      parentCategoryId: null;
      status: string;
    };
    expect(mainBody.storeId).toBe(storeA);
    expect(mainBody.parentCategoryId).toBeNull();
    expect(mainBody.status).toBe("ACTIVE");

    const sub = await createCategory(adminToken, storeA, {
      name: "عصائر",
      parentCategoryId: mainBody.id,
      displayOrder: 2,
    });
    expect(sub.status).toBe(200);
    const subBody = (await sub.json()) as { parentCategoryId: string };
    expect(subBody.parentCategoryId).toBe(mainBody.id);

    const [row] = await harness.client<{ store_id: string; city_id: string }[]>`
      select store_id::text as store_id, city_id::text as city_id
      from store_categories where id = ${mainBody.id}`;
    expect(row?.store_id).toBe(storeA);
    expect(row?.city_id).toBe(cityA);
  });

  test("rejects third-level hierarchy, self-parent, and cross-store parent", async () => {
    const root = await createCategory(adminToken, storeA, { name: "وجبات" });
    const rootId = ((await root.json()) as { id: string }).id;
    const child = await createCategory(adminToken, storeA, {
      name: "وجبات فرعية",
      parentCategoryId: rootId,
    });
    const childId = ((await child.json()) as { id: string }).id;

    expect(
      (
        await errorOf(
          await createCategory(adminToken, storeA, {
            name: "مستوى ثالث",
            parentCategoryId: childId,
          }),
        )
      ).code,
    ).toBe("STORE_CATEGORY_HIERARCHY_INVALID");

    expect(
      (
        await errorOf(
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/stores/${storeA}/categories/${childId}`,
              {
                method: "PATCH",
                token: adminToken,
                body: { parentCategoryId: childId },
              },
            ),
          ),
        )
      ).code,
    ).toBe("STORE_CATEGORY_HIERARCHY_INVALID");

    const otherRoot = await createCategory(adminToken, storeA2, {
      name: "مشروبات",
    });
    const otherRootId = ((await otherRoot.json()) as { id: string }).id;
    expect(
      (
        await errorOf(
          await createCategory(adminToken, storeA, {
            name: "أب أجنبي",
            parentCategoryId: otherRootId,
          }),
        )
      ).code,
    ).toBe("STORE_CATEGORY_NOT_FOUND");
  });

  test("duplicate usable names rejected; archived name can be reused", async () => {
    const first = await createCategory(adminToken, storeA, {
      name: "حلويات",
      displayOrder: 5,
    });
    expect(first.status).toBe(200);
    const firstId = ((await first.json()) as { id: string }).id;

    expect(
      (
        await errorOf(
          await createCategory(adminToken, storeA, { name: "حلويات" }),
        )
      ).code,
    ).toBe("STORE_CATEGORY_NAME_CONFLICT");

    // Same name under different parent is allowed
    const drinks = await createCategory(adminToken, storeA, {
      name: "مشروبات٢",
    });
    const drinksId = ((await drinks.json()) as { id: string }).id;
    expect(
      (
        await createCategory(adminToken, storeA, {
          name: "حلويات",
          parentCategoryId: drinksId,
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await harness.app.handle(
          jsonRequest(
            `/api/v1/dashboard/stores/${storeA}/categories/${firstId}`,
            { method: "DELETE", token: adminToken },
          ),
        )
      ).status,
    ).toBe(200);

    const recreated = await createCategory(adminToken, storeA, {
      name: "حلويات",
      displayOrder: 6,
    });
    expect(recreated.status).toBe(200);
  });

  test("displayOrder listing is deterministic; INACTIVE persists", async () => {
    const s = await createStore(adminToken, "ترتيب", "+9647701000010");
    const b = await createCategory(adminToken, s, {
      name: "ب",
      displayOrder: 2,
    });
    const a = await createCategory(adminToken, s, {
      name: "أ",
      displayOrder: 1,
    });
    const aId = ((await a.json()) as { id: string }).id;
    const bId = ((await b.json()) as { id: string }).id;
    await createCategory(adminToken, s, {
      name: "أ١",
      parentCategoryId: aId,
      displayOrder: 2,
    });
    await createCategory(adminToken, s, {
      name: "أ٢",
      parentCategoryId: aId,
      displayOrder: 1,
    });

    const inactive = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${s}/categories/${bId}`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "INACTIVE" },
      }),
    );
    expect(inactive.status).toBe(200);
    expect(((await inactive.json()) as { status: string }).status).toBe(
      "INACTIVE",
    );

    const list = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${s}/categories`, {
        token: adminToken,
      }),
    );
    expect(list.status).toBe(200);
    const data = (
      (await list.json()) as { data: { name: string; status: string }[] }
    ).data;
    expect(data.map((row) => row.name)).toEqual(["أ", "أ٢", "أ١", "ب"]);
    expect(data.find((row) => row.name === "ب")?.status).toBe("INACTIVE");
  });

  test("archive is soft; parent with children rejected; archived cannot be parent", async () => {
    const root = await createCategory(adminToken, storeA, {
      name: "أرشفة أب",
    });
    const rootId = ((await root.json()) as { id: string }).id;
    const child = await createCategory(adminToken, storeA, {
      name: "أرشفة ابن",
      parentCategoryId: rootId,
    });
    const childId = ((await child.json()) as { id: string }).id;

    expect(
      (
        await errorOf(
          await harness.app.handle(
            jsonRequest(
              `/api/v1/dashboard/stores/${storeA}/categories/${rootId}`,
              { method: "DELETE", token: adminToken },
            ),
          ),
        )
      ).code,
    ).toBe("STORE_CATEGORY_HAS_CHILDREN");

    expect(
      (
        await harness.app.handle(
          jsonRequest(
            `/api/v1/dashboard/stores/${storeA}/categories/${childId}`,
            { method: "DELETE", token: adminToken },
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest(
            `/api/v1/dashboard/stores/${storeA}/categories/${rootId}`,
            { method: "DELETE", token: adminToken },
          ),
        )
      ).status,
    ).toBe(200);

    const [archived] = await harness.client<
      { status: string; archived_at: Date | string | null }[]
    >`select status::text as status, archived_at from store_categories where id = ${rootId}`;
    expect(archived?.status).toBe("ARCHIVED");
    expect(archived?.archived_at).not.toBeNull();

    expect(
      (
        await errorOf(
          await createCategory(adminToken, storeA, {
            name: "تحت مؤرشف",
            parentCategoryId: rootId,
          }),
        )
      ).code,
    ).toBe("STORE_CATEGORY_ARCHIVED");
  });

  test("city isolation, SUPER_ADMIN blocked, employee permissions", async () => {
    const created = await createCategory(adminToken, storeA, {
      name: "عزل",
    });
    const id = ((await created.json()) as { id: string }).id;

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/stores/${storeA}/categories/${id}`, {
            token: adminBToken,
          }),
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/stores/${storeB}/categories`, {
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await createCategory(superToken, storeA, {
          name: "سوبر",
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await errorOf(
          await createCategory(adminToken, storeA, {
            name: "تجاوز مدينة",
            cityId: cityB,
          }),
        )
      ).code,
    ).toBe("VALIDATION_FAILED");

    const empNo = await createStaffAccount(harness.auth, harness.client, {
      email: "scat-emp-noperm@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });
    const noPerm = (
      await login(harness, "scat-emp-noperm@example.com", "noperm")
    ).access_token;
    expect(
      (await createCategory(noPerm, storeA, { name: "ممنوع" })).status,
    ).toBe(403);

    await grant(harness, adminToken, empNo, [
      "store_categories.create",
      "store_categories.read",
    ]);
    const withPerm = (
      await login(harness, "scat-emp-noperm@example.com", "withperm")
    ).access_token;
    expect(
      (await createCategory(withPerm, storeA, { name: "موظف" })).status,
    ).toBe(200);

    expect(
      (await createCategory(employeeToken, storeA, { name: "موظف مخول" }))
        .status,
    ).toBe(200);
  });

  test("DB uniqueness and self-parent check constraints", async () => {
    const root = await createCategory(adminToken, storeA, {
      name: "قيد فريد",
    });
    const rootId = ((await root.json()) as { id: string }).id;

    let dupRejected = false;
    try {
      await harness.client`
        insert into store_categories (
          store_id, city_id, parent_category_id, name, status,
          display_order, created_by_account_id
        ) values (
          ${storeA}, ${cityA}, null, 'قيد فريد', 'ACTIVE', 0, ${adminAccountId}
        )`;
    } catch {
      dupRejected = true;
    }
    expect(dupRejected).toBe(true);

    let selfRejected = false;
    try {
      await harness.client`
        update store_categories set parent_category_id = ${rootId}
        where id = ${rootId}`;
    } catch {
      selfRejected = true;
    }
    expect(selfRejected).toBe(true);
  });
});
