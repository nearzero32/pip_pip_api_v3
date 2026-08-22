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

describe("M3-C2 Subcategories", () => {
  let harness: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let employeeId = "";
  let employeeToken = "";
  let adminAccountId = "";
  let parentA = "";
  let parentA2 = "";
  let parentB = "";

  const cityForToken = (token: string) => token === adminBToken ? cityB : cityA;

  const createReadyAsset = async (token: string, fileName: string) => {
    const city = cityForToken(token);
    const intent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: superToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          cityId: city,
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
          jsonRequest(`/api/v1/dashboard/media/${body.asset.id}/confirm?cityId=${city}`, {
            method: "POST",
            token: superToken,
          }),
        )
      ).status,
    ).toBe(200);
    return body.asset.id;
  };

  const createMain = async (
    token: string,
    name: string,
    displayOrder = 1,
    status: "ACTIVE" | "INACTIVE" = "ACTIVE",
  ) => {
    const response = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/main-categories", {
        method: "POST",
        token: superToken,
        body: {
          cityId: cityForToken(token),
          translations: translationsFor(name),
          imageAssetId: await createReadyAsset(token, `${name}.png`),
          status,
          displayOrder,
        },
      }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { id: string }).id;
  };

  const createSub = (
    token: string,
    body: Record<string, unknown>,
  ) => {
    const { name, ...rest } = body;
    return harness.app.handle(
      jsonRequest("/api/v1/dashboard/subcategories", {
        method: "POST",
        token,
        body: {
          ...rest,
          ...(typeof name === "string" ? { translations: translationsFor(name) } : {}),
        },
      }),
    );
  };

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_m3c2",
    });
    cityA = await createActiveCity(harness.client, "Sub City A");
    cityB = await createActiveCity(harness.client, "Sub City B");

    await createStaffAccount(harness.auth, harness.client, {
      email: "m3c2-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    adminAccountId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3c2-admin@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "m3c2-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    employeeId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3c2-emp@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });

    superToken = (await login(harness, "m3c2-super@example.com", "super")).access_token;
    adminToken = (await login(harness, "m3c2-admin@example.com", "admin")).access_token;
    adminBToken = (await login(harness, "m3c2-admin-b@example.com", "admin-b")).access_token;
    await grant(harness, adminToken, employeeId, [
      "media.read",
      "media.create",
      "media.delete",
      "subcategories.read",
      "subcategories.create",
      "subcategories.update",
      "subcategories.archive",
    ]);
    employeeToken = (await login(harness, "m3c2-emp@example.com", "emp")).access_token;

    parentA = await createMain(adminToken, "مطاعم", 1);
    parentA2 = await createMain(adminToken, "حلويات", 2);
    parentB = await createMain(adminBToken, "مطاعم ب", 1);
  });

  afterAll(async () => {
    await harness.close();
  });

  test("ADMIN and employee can create; permission and SUPER_ADMIN gates", async () => {
    const adminCreate = await createSub(adminToken, {
      mainCategoryId: parentA,
      name: "برغر",
      status: "ACTIVE",
      displayOrder: 1,
    });
    expect(adminCreate.status).toBe(200);
    const adminBody = (await adminCreate.json()) as {
      image: null;
      mainCategory: { id: string; name: string };
    };
    expect(adminBody.image).toBeNull();
    expect(adminBody.mainCategory.id).toBe(parentA);

    const withImage = await createSub(employeeToken, {
      mainCategoryId: parentA,
      name: "بيتزا",
      imageAssetId: await createReadyAsset(adminToken, "pizza.png"),
      displayOrder: 2,
    });
    expect(withImage.status).toBe(200);
    const imgBody = (await withImage.json()) as {
      image: { assetId: string; url: string };
    };
    expect(imgBody.image.url).toContain("https://media.test.example.com/");
    expect(JSON.stringify(imgBody)).not.toContain("objectKey");

    expect(
      (
        await createSub(superToken, {
          mainCategoryId: parentA,
          name: "ممنوع",
        })
      ).status,
    ).toBe(403);

    const empNo = await createStaffAccount(harness.auth, harness.client, {
      email: "m3c2-noperm@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });
    const noToken = (await login(harness, "m3c2-noperm@example.com", "nop")).access_token;
    expect(
      (
        await createSub(noToken, {
          mainCategoryId: parentA,
          name: "بدون صلاحية",
        })
      ).status,
    ).toBe(403);
    await grant(harness, adminToken, empNo, ["subcategories.create"]);
    expect(
      (
        await createSub(noToken, {
          mainCategoryId: parentA,
          name: "بعد المنح",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest(
            `/api/v1/dashboard/employees/${empNo}/permissions/subcategories.create`,
            { method: "DELETE", token: adminToken },
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await createSub(noToken, {
          mainCategoryId: parentA,
          name: "بعد الإلغاء",
        })
      ).status,
    ).toBe(403);
  });

  test("creation rejects bad parents, statuses, and controlled fields", async () => {
    expect(
      (await createSub(adminToken, { name: "بدون أب" })).status,
    ).toBe(422);

    const missing = await createSub(adminToken, {
      mainCategoryId: crypto.randomUUID(),
      name: "مفقود",
    });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("MAIN_CATEGORY_NOT_FOUND");

    const cross = await createSub(adminToken, {
      mainCategoryId: parentB,
      name: "أجنبي",
    });
    expect(cross.status).toBe(404);
    expect((await errorOf(cross)).code).toBe("MAIN_CATEGORY_NOT_FOUND");

    const inactiveParent = await createMain(adminToken, "أب خامل", 9, "INACTIVE");
    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: inactiveParent,
          name: "طفل نشط",
          status: "ACTIVE",
        })
      ).status,
    ).toBe(200);

    const archivedParent = await createMain(adminToken, "أب مؤرشف", 10);
    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${archivedParent}?cityId=${cityA}`, {
        method: "DELETE",
        token: superToken,
      }),
    );
    const underArchived = await createSub(adminToken, {
      mainCategoryId: archivedParent,
      name: "طفل مرفوض",
    });
    expect(underArchived.status).toBe(409);
    expect((await errorOf(underArchived)).code).toBe("MAIN_CATEGORY_ARCHIVED");

    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: parentA,
          name: "أرشيف مباشر",
          status: "ARCHIVED",
        })
      ).status,
    ).toBe(422);

    for (const body of [
      { mainCategoryId: parentA, name: "س", cityId: cityA },
      { mainCategoryId: parentA, name: "س", description: "x" },
      { mainCategoryId: parentA, name: "س", descriptionAr: "x" },
      { mainCategoryId: parentA, name: "س", nameEn: "x" },
      { mainCategoryId: parentA, name: "س", imageAssetId: null },
      { mainCategoryId: parentA, name: "س", displayOrder: -1 },
    ]) {
      expect((await createSub(adminToken, body)).status).toBe(422);
    }
  });

  test("image claim, validation, uniqueness, and rollback", async () => {
    const claimed = await createReadyAsset(adminToken, "claim-sub.png");
    const ok = await createSub(adminToken, {
      mainCategoryId: parentA,
      name: "مشويات",
      imageAssetId: claimed,
    });
    expect(ok.status).toBe(200);
    const [attached] = await harness.client<{ attached_at: Date | null }[]>`
      select attached_at from media_assets where id = ${claimed}`;
    expect(attached?.attached_at).not.toBeNull();

    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: parentA,
          name: "مكرر صورة",
          imageAssetId: claimed,
        })
      ).status,
    ).toBe(409);

    const nonexistent = await createSub(adminToken, {
      mainCategoryId: parentA,
      name: "لا يوجد",
      imageAssetId: crypto.randomUUID(),
    });
    expect((await errorOf(nonexistent)).code).toBe("MEDIA_NOT_ATTACHABLE");

    const foreign = await createReadyAsset(adminBToken, "foreign-sub.png");
    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: parentA,
          name: "صورة أجنبية",
          imageAssetId: foreign,
        })
      ).status,
    ).toBe(409);

    const pending = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: superToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          cityId: cityA,
          fileName: "pending-sub.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const pendingId = ((await pending.json()) as { asset: { id: string } }).asset
      .id;
    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: parentA,
          name: "معلق",
          imageAssetId: pendingId,
        })
      ).status,
    ).toBe(409);

    const privateId = crypto.randomUUID();
    await harness.client`
      insert into media_assets (
        id, city_id, purpose, visibility, status,
        object_key, original_name, expected_content_type, expected_size_bytes,
        verified_content_type, verified_size_bytes,
        created_by_account_id, upload_expires_at, ready_at
      ) values (
        ${privateId}, ${cityA}, 'CATEGORY_IMAGE', 'PRIVATE', 'READY',
        ${`cities/${cityA}/categories/${privateId}/original.png`},
        'p.png', 'image/png', ${pngBytes.length},
        'image/png', ${pngBytes.length},
        ${adminAccountId}, now() + interval '1 hour', now()
      )`;
    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: parentA,
          name: "خاص",
          imageAssetId: privateId,
        })
      ).status,
    ).toBe(409);

    const wrongPurpose = crypto.randomUUID();
    await harness.client`
      insert into media_assets (
        id, city_id, purpose, visibility, status,
        object_key, original_name, expected_content_type, expected_size_bytes,
        verified_content_type, verified_size_bytes,
        created_by_account_id, upload_expires_at, ready_at
      ) values (
        ${wrongPurpose}, ${cityA}, 'STORE_LOGO', 'PUBLIC', 'READY',
        ${`cities/${cityA}/stores/${wrongPurpose}/logo.png`},
        'l.png', 'image/png', ${pngBytes.length},
        'image/png', ${pngBytes.length},
        ${adminAccountId}, now() + interval '1 hour', now()
      )`;
    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: parentA,
          name: "شعار",
          imageAssetId: wrongPurpose,
        })
      ).status,
    ).toBe(409);

    const rollbackAsset = await createReadyAsset(adminToken, "rollback-sub.png");
    const conflict = await createSub(adminToken, {
      mainCategoryId: parentA,
      name: "مشويات",
      imageAssetId: rollbackAsset,
    });
    expect(conflict.status).toBe(409);
    expect((await errorOf(conflict)).code).toBe("SUBCATEGORY_NAME_CONFLICT");
    const [rolled] = await harness.client<{ attached_at: Date | null }[]>`
      select attached_at from media_assets where id = ${rollbackAsset}`;
    expect(rolled?.attached_at).toBeNull();

    let uniqFailed = false;
    try {
      await harness.client.unsafe(
        `insert into subcategories (
          city_id, main_category_id, name, image_asset_id, status, display_order, created_by_account_id
        ) values ($1::uuid, $2::uuid, $3, $4::uuid, 'ACTIVE', 99, $5::uuid)`,
        [cityA, parentA2, "فهرس فريد", claimed, adminAccountId],
      );
    } catch {
      uniqFailed = true;
    }
    expect(uniqFailed).toBe(true);

    const raceAsset = await createReadyAsset(adminToken, "race-sub.png");
    const race = await Promise.all([
      createSub(adminToken, {
        mainCategoryId: parentA,
        name: "سباق ١",
        imageAssetId: raceAsset,
      }),
      createSub(adminToken, {
        mainCategoryId: parentA2,
        name: "سباق ٢",
        imageAssetId: raceAsset,
      }),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  test("name uniqueness scoped to parent; archived names reusable", async () => {
    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: parentA,
          name: "اسم مشترك",
        })
      ).status,
    ).toBe(200);
    const sameParent = await createSub(adminToken, {
      mainCategoryId: parentA,
      name: "  اسم مشترك  ",
    });
    expect(sameParent.status).toBe(409);
    expect((await errorOf(sameParent)).code).toBe("SUBCATEGORY_NAME_CONFLICT");

    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: parentA2,
          name: "اسم مشترك",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await createSub(adminBToken, {
          mainCategoryId: parentB,
          name: "اسم مشترك",
        })
      ).status,
    ).toBe(200);

    const created = await createSub(adminToken, {
      mainCategoryId: parentA,
      name: "للإعادة",
    });
    const id = ((await created.json()) as { id: string }).id;
    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: parentA,
          name: "للإعادة",
        })
      ).status,
    ).toBe(200);
  });

  test("dashboard list/detail City scope, filters, ordering", async () => {
    const low = await createSub(adminToken, {
      mainCategoryId: parentA2,
      name: "ترتيب منخفض",
      displayOrder: 2,
    });
    const high = await createSub(adminToken, {
      mainCategoryId: parentA2,
      name: "ترتيب مرتفع",
      displayOrder: 1,
    });
    const lowId = ((await low.json()) as { id: string }).id;
    const highId = ((await high.json()) as { id: string }).id;
    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${lowId}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );

    const list = await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/subcategories?mainCategoryId=${parentA2}&limit=100`,
        { token: adminToken },
      ),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { id: string; name: string }[];
    };
    expect(body.data.some((row) => row.id === lowId)).toBe(false);
    const ordered = body.data.filter((row) =>
      ["ترتيب مرتفع"].includes(row.name),
    );
    expect(ordered[0]?.id).toBe(highId);

    const search = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories?search=${encodeURIComponent("ترتيب")}`, {
        token: adminToken,
      }),
    );
    expect(
      ((await search.json()) as { data: { name: string }[] }).data.some((row) =>
        row.name.includes("ترتيب"),
      ),
    ).toBe(true);

    const cross = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${highId}`, {
        token: adminBToken,
      }),
    );
    expect(cross.status).toBe(404);
    expect((await errorOf(cross)).code).toBe("SUBCATEGORY_NOT_FOUND");
  });

  test("updates, movement, and image attach/replace/remove", async () => {
    const created = await createSub(adminToken, {
      mainCategoryId: parentA,
      name: "للتحديث",
      displayOrder: 40,
    });
    const id = ((await created.json()) as { id: string }).id;

    const updated = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { translations: translationsFor("تم التحديث"), status: "INACTIVE", displayOrder: 8 },
      }),
    );
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      name: string;
      status: string;
      displayOrder: number;
    };
    expect(updatedBody.name).toBe("تم التحديث");
    expect(updatedBody.status).toBe("INACTIVE");
    expect(updatedBody.displayOrder).toBe(8);

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
            method: "PATCH",
            token: adminToken,
            body: { status: "ARCHIVED" },
          }),
        )
      ).status,
    ).toBe(422);

    const moved = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { mainCategoryId: parentA2, status: "ACTIVE" },
      }),
    );
    expect(moved.status).toBe(200);
    expect(
      ((await moved.json()) as { mainCategory: { id: string } }).mainCategory.id,
    ).toBe(parentA2);

    const crossMove = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { mainCategoryId: parentB },
      }),
    );
    expect(crossMove.status).toBe(404);

    const archivedParent = await createMain(adminToken, "هدف مؤرشف", 20);
    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${archivedParent}?cityId=${cityA}`, {
        method: "DELETE",
        token: superToken,
      }),
    );
    const moveArchived = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { mainCategoryId: archivedParent },
      }),
    );
    expect(moveArchived.status).toBe(409);
    expect((await errorOf(moveArchived)).code).toBe("MAIN_CATEGORY_ARCHIVED");

    await createSub(adminToken, {
      mainCategoryId: parentA,
      name: "مانع النقل",
    });
    const moveConflict = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { mainCategoryId: parentA, translations: translationsFor("مانع النقل") },
      }),
    );
    expect(moveConflict.status).toBe(409);

    const attachId = await createReadyAsset(adminToken, "attach-sub.png");
    const attached = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { imageAssetId: attachId },
      }),
    );
    expect(attached.status).toBe(200);

    const same = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { imageAssetId: attachId },
      }),
    );
    expect(same.status).toBe(200);
    const [still] = await harness.client<
      { status: string; attached_at: Date | null }[]
    >`select status::text as status, attached_at from media_assets where id = ${attachId}`;
    expect(still?.status).toBe("READY");
    expect(still?.attached_at).not.toBeNull();

    const replaceId = await createReadyAsset(adminToken, "replace-sub.png");
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
            method: "PATCH",
            token: adminToken,
            body: { imageAssetId: replaceId },
          }),
        )
      ).status,
    ).toBe(200);
    const [oldAsset] = await harness.client<{ status: string }[]>`
      select status::text as status from media_assets where id = ${attachId}`;
    expect(oldAsset?.status).toBe("DELETE_PENDING");

    const failNew = await createReadyAsset(adminToken, "fail-new-sub.png");
    await createSub(adminToken, {
      mainCategoryId: parentA2,
      name: "مانع الاستبدال",
    });
    const failed = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { imageAssetId: failNew, translations: translationsFor("مانع الاستبدال") },
      }),
    );
    expect(failed.status).toBe(409);
    const [cat] = await harness.client<{ image_asset_id: string }[]>`
      select image_asset_id::text as image_asset_id from subcategories where id = ${id}`;
    expect(cat?.image_asset_id).toBe(replaceId);
    const [failAsset] = await harness.client<{ attached_at: Date | null }[]>`
      select attached_at from media_assets where id = ${failNew}`;
    expect(failAsset?.attached_at).toBeNull();

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
            method: "PATCH",
            token: adminToken,
            body: { imageAssetId: null },
          }),
        )
      ).status,
    ).toBe(200);
    const cleared = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { imageAssetId: null },
      }),
    );
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { image: null }).image).toBeNull();
  });

  test("archive releases image; parent archive hides children; concurrent create vs archive", async () => {
    const imageId = await createReadyAsset(adminToken, "archive-sub.png");
    const created = await createSub(adminToken, {
      mainCategoryId: parentA,
      name: "للأرشفة",
      imageAssetId: imageId,
      displayOrder: 70,
    });
    const id = ((await created.json()) as { id: string }).id;

    const first = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      status: string;
      image: null;
      archivedAt: string | null;
    };
    expect(firstBody.status).toBe("ARCHIVED");
    expect(firstBody.image).toBeNull();
    expect(firstBody.archivedAt).not.toBeNull();
    const [asset] = await harness.client<
      { status: string; attached_at: Date | null }[]
    >`select status::text as status, attached_at from media_assets where id = ${imageId}`;
    expect(asset?.status).toBe("DELETE_PENDING");
    expect(asset?.attached_at).toBeNull();
    const [row] = await harness.client<{ image_asset_id: string | null }[]>`
      select image_asset_id::text as image_asset_id from subcategories where id = ${id}`;
    expect(row?.image_asset_id).toBeNull();

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/subcategories/${id}`, {
            method: "DELETE",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: parentA,
          name: "بلا صورة أرشفة",
        })
      ).status,
    ).toBe(200);

    const parent = await createMain(adminToken, "أب للأطفال", 30);
    const child = await createSub(adminToken, {
      mainCategoryId: parent,
      name: "طفل ظاهر",
      status: "ACTIVE",
      imageAssetId: await createReadyAsset(adminToken, "child-vis.png"),
    });
    const childId = ((await child.json()) as { id: string }).id;
    const childImage = (
      (await (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/subcategories/${childId}`, {
            token: adminToken,
          }),
        )
      ).json()) as { image: { assetId: string } }
    ).image.assetId;

    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${parent}?cityId=${cityA}`, {
        method: "PATCH",
        token: superToken,
        body: { status: "INACTIVE" },
      }),
    );
    const inactivePublic = await harness.app.handle(
      new Request(
        `http://localhost/api/v1/public/subcategories?mainCategoryId=${parent}`,
        { headers: { "X-City-Id": cityA } },
      ),
    );
    expect(inactivePublic.status).toBe(404);

    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${parent}?cityId=${cityA}`, {
        method: "PATCH",
        token: superToken,
        body: { status: "ACTIVE" },
      }),
    );
    const activePublic = await harness.app.handle(
      new Request(
        `http://localhost/api/v1/public/subcategories?mainCategoryId=${parent}`,
        { headers: { "X-City-Id": cityA } },
      ),
    );
    expect(activePublic.status).toBe(200);
    expect(
      ((await activePublic.json()) as { data: { id: string }[] }).data.some(
        (row) => row.id === childId,
      ),
    ).toBe(true);

    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${parent}?cityId=${cityA}`, {
        method: "DELETE",
        token: superToken,
      }),
    );
    const [childAfter] = await harness.client<
      { status: string; image_asset_id: string | null }[]
    >`select status::text as status, image_asset_id::text as image_asset_id
      from subcategories where id = ${childId}`;
    expect(childAfter?.status).toBe("ACTIVE");
    expect(childAfter?.image_asset_id).toBe(childImage);
    const [childMedia] = await harness.client<
      { status: string; attached_at: Date | null }[]
    >`select status::text as status, attached_at from media_assets where id = ${childImage}`;
    expect(childMedia?.status).toBe("READY");
    expect(childMedia?.attached_at).not.toBeNull();

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/subcategories/${childId}`, {
            method: "PATCH",
            token: adminToken,
            body: { translations: translationsFor("لا تحديث") },
          }),
        )
      ).status,
    ).toBe(409);

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/subcategories/${childId}`, {
            method: "DELETE",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);

    const raceParent = await createMain(adminToken, "سباق أب", 40);
    const results = await Promise.all([
      createSub(adminToken, {
        mainCategoryId: raceParent,
        name: "طفل سباق",
      }),
      harness.app.handle(
        jsonRequest(`/api/v1/dashboard/main-categories/${raceParent}?cityId=${cityA}`, {
          method: "DELETE",
          token: superToken,
        }),
      ),
    ]);
    const createStatus = results[0]!.status;
    const archiveStatus = results[1]!.status;
    expect(archiveStatus).toBe(200);
    if (createStatus === 200) {
      const createdId = ((await results[0]!.json()) as { id: string }).id;
      const [parentRow] = await harness.client<{ status: string }[]>`
        select status::text as status from main_categories where id = ${raceParent}`;
      if (parentRow?.status === "ARCHIVED") {
        const [childRow] = await harness.client<{ main_category_id: string }[]>`
          select main_category_id::text as main_category_id from subcategories where id = ${createdId}`;
        expect(childRow?.main_category_id).toBe(raceParent);
      }
    } else {
      expect([409, 404]).toContain(createStatus);
    }
  });

  test("public endpoint rules and OpenAPI", async () => {
    const parent = await createMain(adminToken, "أب علني", 50);
    await createSub(adminToken, {
      mainCategoryId: parent,
      name: "علني مرتفع",
      displayOrder: 1,
      status: "ACTIVE",
    });
    await createSub(adminToken, {
      mainCategoryId: parent,
      name: "علني منخفض",
      displayOrder: 2,
      status: "ACTIVE",
      imageAssetId: await createReadyAsset(adminToken, "pub-sub.png"),
    });
    await createSub(adminToken, {
      mainCategoryId: parent,
      name: "خامل علني",
      status: "INACTIVE",
      displayOrder: 0,
    });

    expect(
      (
        await harness.app.handle(
          new Request("http://localhost/api/v1/public/subcategories"),
        )
      ).status,
    ).toBe(422);

    expect(
      (
        await harness.app.handle(
          new Request(
            `http://localhost/api/v1/public/subcategories?mainCategoryId=${parent}`,
          ),
        )
      ).status,
    ).toBe(400);

    const list = await harness.app.handle(
      new Request(
        `http://localhost/api/v1/public/subcategories?mainCategoryId=${parent}`,
        { headers: { "X-City-Id": cityA } },
      ),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { name: string; image: { url: string } | null; displayOrder: number }[];
    };
    expect(body.data.map((row) => row.name)).toEqual([
      "علني مرتفع",
      "علني منخفض",
    ]);
    expect(body.data[0]!.image).toBeNull();
    expect(body.data[1]!.image?.url).toContain("https://media.test.example.com/");
    expect(JSON.stringify(body)).not.toContain("object_key");

    expect(
      (
        await harness.app.handle(
          new Request(
            `http://localhost/api/v1/public/subcategories?mainCategoryId=${parent}`,
            { headers: { "X-City-Id": cityB } },
          ),
        )
      ).status,
    ).toBe(404);

    const doc = (await (
      await harness.app.handle(new Request("http://localhost/openapi/json"))
    ).json()) as {
      tags: { name: string }[];
      paths: Record<string, unknown>;
    };
    expect(doc.tags.some((tag) => tag.name === "Dashboard — Subcategories")).toBe(
      true,
    );
    expect(doc.tags.some((tag) => tag.name === "Public — Subcategories")).toBe(
      true,
    );
    expect(doc.paths["/api/v1/dashboard/subcategories"]).toBeTruthy();
    expect(doc.paths["/api/v1/public/subcategories"]).toBeTruthy();
  });

  test("database composite City FK and checks", async () => {
    let cityMismatch = false;
    try {
      await harness.client.unsafe(
        `insert into subcategories (
          city_id, main_category_id, name, status, display_order, created_by_account_id
        ) values ($1::uuid, $2::uuid, $3, 'ACTIVE', 0, $4::uuid)`,
        [cityA, parentB, "مركب خاطئ", adminAccountId],
      );
    } catch {
      cityMismatch = true;
    }
    expect(cityMismatch).toBe(true);

    let archiveChk = false;
    try {
      await harness.client.unsafe(
        `insert into subcategories (
          city_id, main_category_id, name, status, display_order, created_by_account_id, archived_at
        ) values ($1::uuid, $2::uuid, $3, 'ARCHIVED', 0, $4::uuid, null)`,
        [cityA, parentA, "فحص أرشيف", adminAccountId],
      );
    } catch {
      archiveChk = true;
    }
    expect(archiveChk).toBe(true);

    let orderChk = false;
    try {
      await harness.client.unsafe(
        `insert into subcategories (
          city_id, main_category_id, name, status, display_order, created_by_account_id
        ) values ($1::uuid, $2::uuid, $3, 'ACTIVE', -1, $4::uuid)`,
        [cityA, parentA, "فحص ترتيب", adminAccountId],
      );
    } catch {
      orderChk = true;
    }
    expect(orderChk).toBe(true);
  });

  test("suspended City rejects mutations; body cannot override City", async () => {
    const suspendedCity = await createActiveCity(harness.client, "Susp Sub");
    await createStaffAccount(harness.auth, harness.client, {
      email: "m3c2-susp@example.com",
      password,
      roles: ["ADMIN"],
      cityId: suspendedCity,
    });
    const token = (await login(harness, "m3c2-susp@example.com", "susp")).access_token;
    await harness.client`
      update cities set status='SUSPENDED', updated_at=now() where id=${suspendedCity}`;
    expect(
      (
        await createSub(token, {
          mainCategoryId: crypto.randomUUID(),
          name: "معلق",
        })
      ).status,
    ).toBe(409);

    expect(
      (
        await createSub(adminToken, {
          mainCategoryId: parentA,
          name: "تجاوز",
          cityId: cityB,
        })
      ).status,
    ).toBe(422);
  });
});
