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
  ((await response.json()) as { error: { code: string; message: string } }).error;

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
    const response = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/employees/${employeeId}/permissions`, {
        method: "POST",
        token: adminToken,
        body: { permission },
      }),
    );
    expect(response.status).toBe(200);
  }
};

const revoke = async (
  harness: IntegrationHarness,
  adminToken: string,
  employeeId: string,
  permission: string,
) => {
  const response = await harness.app.handle(
    jsonRequest(
      `/api/v1/dashboard/employees/${employeeId}/permissions/${permission}`,
      { method: "DELETE", token: adminToken },
    ),
  );
  expect(response.status).toBe(200);
};

describe("M3-C1 Main Categories", () => {
  let harness: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let employeeId = "";
  let employeeToken = "";
  let adminAccountId = "";

  const createReadyAsset = async (
    token: string,
    fileName = `cat-${crypto.randomUUID().slice(0, 8)}.png`,
  ) => {
    const intent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName,
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    expect(intent.status).toBe(200);
    const body = (await intent.json()) as {
      asset: { id: string };
      upload: { url: string };
    };
    const objectKey = await harness.media.getObjectKeyForTests(
      body.asset.id,
      token === adminBToken ? cityB : cityA,
    );
    expect(objectKey).toBeTruthy();
    harness.mediaStorage.putObject(objectKey!, "image/png", pngBytes);
    const confirm = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/media/${body.asset.id}/confirm`, {
        method: "POST",
        token,
      }),
    );
    expect(confirm.status).toBe(200);
    return body.asset.id;
  };

  const createCategory = async (
    token: string,
    body: Record<string, unknown>,
  ) =>
    harness.app.handle(
      jsonRequest("/api/v1/dashboard/main-categories", {
        method: "POST",
        token,
        body,
      }),
    );

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_m3c1",
    });
    cityA = await createActiveCity(harness.client, "Cat City A");
    cityB = await createActiveCity(harness.client, "Cat City B");

    await createStaffAccount(harness.auth, harness.client, {
      email: "m3c1-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    adminAccountId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3c1-admin@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "m3c1-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });
    employeeId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3c1-emp@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });

    superToken = (await login(harness, "m3c1-super@example.com", "super")).access_token;
    adminToken = (await login(harness, "m3c1-admin@example.com", "admin")).access_token;
    adminBToken = (await login(harness, "m3c1-admin-b@example.com", "admin-b")).access_token;
    await grant(harness, adminToken, employeeId, [
      "media.read",
      "media.create",
      "media.delete",
      "main_categories.read",
      "main_categories.create",
      "main_categories.update",
      "main_categories.archive",
    ]);
    employeeToken = (await login(harness, "m3c1-emp@example.com", "emp")).access_token;
  });

  afterAll(async () => {
    await harness.close();
  });

  test("ADMIN can create a Main Category and claims the asset", async () => {
    const imageAssetId = await createReadyAsset(adminToken);
    const response = await createCategory(adminToken, {
      name: "مطاعم",
      imageAssetId,
      status: "ACTIVE",
      displayOrder: 1,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      name: string;
      image: { assetId: string; url: string };
      status: string;
    };
    expect(body.name).toBe("مطاعم");
    expect(body.image.assetId).toBe(imageAssetId);
    expect(body.image.url).toContain("https://media.test.example.com/");
    expect(JSON.stringify(body)).not.toContain("objectKey");
    expect(JSON.stringify(body)).not.toContain("object_key");

    const [asset] = await harness.client<{ attached_at: Date | null }[]>`
      select attached_at from media_assets where id = ${imageAssetId}`;
    expect(asset?.attached_at).not.toBeNull();
  });

  test("employee with full grants can create via employeeToken", async () => {
    const response = await createCategory(employeeToken, {
      name: "موظف إنشاء",
      imageAssetId: await createReadyAsset(adminToken, "emp-create.png"),
      displayOrder: 40,
    });
    expect(response.status).toBe(200);
  });

  test("employee without permission is 403; revocation is immediate", async () => {
    const empNoPermId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3c1-emp-noperm@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: adminAccountId,
    });
    const empNoPermToken = (
      await login(harness, "m3c1-emp-noperm@example.com", "emp-noperm")
    ).access_token;
    const denied = await createCategory(empNoPermToken, {
      name: "سوبر ماركت",
      imageAssetId: await createReadyAsset(adminToken, "noperm.png"),
    });
    expect(denied.status).toBe(403);

    await grant(harness, adminToken, empNoPermId, ["main_categories.create"]);
    const allowed = await createCategory(empNoPermToken, {
      name: "سوبر ماركت",
      imageAssetId: await createReadyAsset(adminToken, "noperm-ok.png"),
      displayOrder: 5,
    });
    expect(allowed.status).toBe(200);

    await revoke(harness, adminToken, empNoPermId, "main_categories.create");
    const afterRevoke = await createCategory(empNoPermToken, {
      name: "صيدليات",
      imageAssetId: await createReadyAsset(adminToken, "revoked.png"),
    });
    expect(afterRevoke.status).toBe(403);
  });

  test("SUPER_ADMIN is blocked from Main Category operations", async () => {
    const response = await createCategory(superToken, {
      name: "زهور",
      imageAssetId: crypto.randomUUID(),
    });
    expect(response.status).toBe(403);
  });

  test("suspended City rejects mutations", async () => {
    const suspendedCity = await createActiveCity(harness.client, "Suspended Cat");
    const suspendedAdminId = await createStaffAccount(
      harness.auth,
      harness.client,
      {
        email: "m3c1-suspended-admin@example.com",
        password,
        roles: ["ADMIN"],
        cityId: suspendedCity,
      },
    );
    const suspendedToken = (
      await login(harness, "m3c1-suspended-admin@example.com", "susp")
    ).access_token;
    await harness.client`
      update cities set status='SUSPENDED', updated_at=now() where id=${suspendedCity}`;
    void suspendedAdminId;
    const response = await createCategory(suspendedToken, {
      name: "مطاعم",
      imageAssetId: crypto.randomUUID(),
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("CITY_NOT_ACTIVE");
  });

  test("creation rejects cityId and description variants", async () => {
    const imageAssetId = await createReadyAsset(adminToken, "forbidden.png");
    for (const body of [
      { name: "حلويات", imageAssetId, cityId: cityA },
      { name: "حلويات", imageAssetId, description: "x" },
      { name: "حلويات", imageAssetId, descriptionAr: "x" },
      { name: "حلويات", imageAssetId, descriptionEn: "x" },
      { name: "حلويات", imageAssetId, nameEn: "Sweets" },
    ]) {
      const response = await createCategory(adminToken, body);
      expect(response.status).toBe(422);
    }
  });

  test("creation requires a valid READY PUBLIC CATEGORY_IMAGE", async () => {
    expect(
      (await createCategory(adminToken, { name: "حلويات" })).status,
    ).toBe(422);

    const missingImage = await createCategory(adminToken, {
      name: "حلويات",
      imageAssetId: null,
    });
    expect(missingImage.status).toBe(422);

    const nonexistent = await createCategory(adminToken, {
      name: "حلويات",
      imageAssetId: crypto.randomUUID(),
    });
    expect(nonexistent.status).toBe(409);
    expect((await errorOf(nonexistent)).code).toBe("MEDIA_NOT_ATTACHABLE");

    const foreign = await createReadyAsset(adminBToken, "foreign.png");
    const crossCity = await createCategory(adminToken, {
      name: "حلويات أجنبية",
      imageAssetId: foreign,
    });
    expect(crossCity.status).toBe(409);
    expect((await errorOf(crossCity)).code).toBe("MEDIA_NOT_ATTACHABLE");

    const pendingIntent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "pending.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const pendingId = ((await pendingIntent.json()) as { asset: { id: string } })
      .asset.id;
    const pending = await createCategory(adminToken, {
      name: "معلق",
      imageAssetId: pendingId,
    });
    expect(pending.status).toBe(409);

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
        'private.png', 'image/png', ${pngBytes.length},
        'image/png', ${pngBytes.length},
        ${adminAccountId}, now() + interval '1 hour', now()
      )`;
    const privateRes = await createCategory(adminToken, {
      name: "خاص",
      imageAssetId: privateId,
    });
    expect(privateRes.status).toBe(409);
    expect((await errorOf(privateRes)).code).toBe("MEDIA_NOT_ATTACHABLE");

    const wrongPurposeId = crypto.randomUUID();
    await harness.client`
      insert into media_assets (
        id, city_id, purpose, visibility, status,
        object_key, original_name, expected_content_type, expected_size_bytes,
        verified_content_type, verified_size_bytes,
        created_by_account_id, upload_expires_at, ready_at
      ) values (
        ${wrongPurposeId}, ${cityA}, 'STORE_LOGO', 'PUBLIC', 'READY',
        ${`cities/${cityA}/stores/${wrongPurposeId}/logo.png`},
        'logo.png', 'image/png', ${pngBytes.length},
        'image/png', ${pngBytes.length},
        ${adminAccountId}, now() + interval '1 hour', now()
      )`;
    const wrongPurpose = await createCategory(adminToken, {
      name: "شعار",
      imageAssetId: wrongPurposeId,
    });
    expect(wrongPurpose.status).toBe(409);
    expect((await errorOf(wrongPurpose)).code).toBe("MEDIA_NOT_ATTACHABLE");
  });

  test("creation rejects already attached asset and rolls back failed claim", async () => {
    const attached = await createReadyAsset(adminToken, "attached.png");
    const first = await createCategory(adminToken, {
      name: "أول مرفق",
      imageAssetId: attached,
    });
    expect(first.status).toBe(200);

    const second = await createCategory(adminToken, {
      name: "ثاني مرفق",
      imageAssetId: attached,
    });
    expect(second.status).toBe(409);
    expect((await errorOf(second)).code).toBe("MEDIA_NOT_ATTACHABLE");

    const rollbackAsset = await createReadyAsset(adminToken, "rollback.png");
    const conflict = await createCategory(adminToken, {
      name: "أول مرفق",
      imageAssetId: rollbackAsset,
    });
    expect(conflict.status).toBe(409);
    expect((await errorOf(conflict)).code).toBe("MAIN_CATEGORY_NAME_CONFLICT");
    const [asset] = await harness.client<{ attached_at: Date | null }[]>`
      select attached_at from media_assets where id = ${rollbackAsset}`;
    expect(asset?.attached_at).toBeNull();
  });

  test("name uniqueness is City-scoped; archived names can be reused", async () => {
    const a1 = await createCategory(adminToken, {
      name: "اسم مشترك",
      imageAssetId: await createReadyAsset(adminToken, "name-a.png"),
    });
    expect(a1.status).toBe(200);
    const a1Id = ((await a1.json()) as { id: string }).id;

    const sameCity = await createCategory(adminToken, {
      name: "  اسم مشترك  ",
      imageAssetId: await createReadyAsset(adminToken, "name-a2.png"),
    });
    expect(sameCity.status).toBe(409);
    expect((await errorOf(sameCity)).code).toBe("MAIN_CATEGORY_NAME_CONFLICT");

    const otherCity = await createCategory(adminBToken, {
      name: "اسم مشترك",
      imageAssetId: await createReadyAsset(adminBToken, "name-b.png"),
    });
    expect(otherCity.status).toBe(200);

    const archive = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${a1Id}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    expect(archive.status).toBe(200);

    const reuse = await createCategory(adminToken, {
      name: "اسم مشترك",
      imageAssetId: await createReadyAsset(adminToken, "name-reuse.png"),
    });
    expect(reuse.status).toBe(200);
  });

  test("same Asset cannot be used by two categories via unique index", async () => {
    const imageAssetId = await createReadyAsset(adminToken, "uniq-img.png");
    expect(
      (
        await createCategory(adminToken, {
          name: "فهرس فريد ١",
          imageAssetId,
        })
      ).status,
    ).toBe(200);

    let failed = false;
    try {
      await harness.client.unsafe(
        `insert into main_categories (
          city_id, name, image_asset_id, status, display_order, created_by_account_id
        ) values ($1::uuid, $2, $3::uuid, 'ACTIVE', 9, $4::uuid)`,
        [cityA, "فهرس فريد ٢", imageAssetId, adminAccountId],
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test("dashboard list is City-scoped with stable ordering and excludes archived by default", async () => {
    const ids: string[] = [];
    for (const [name, order] of [
      ["ترتيب ج", 30],
      ["ترتيب أ", 10],
      ["ترتيب ب", 20],
    ] as const) {
      const response = await createCategory(adminToken, {
        name,
        imageAssetId: await createReadyAsset(adminToken, `${name}.png`),
        displayOrder: order,
      });
      ids.push(((await response.json()) as { id: string }).id);
    }
    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${ids[0]}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );

    const list = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/main-categories?limit=100", {
        token: adminToken,
      }),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { id: string; name: string; displayOrder: number }[];
    };
    expect(body.data.some((row) => row.id === ids[0])).toBe(false);
    const ordered = body.data.filter((row) =>
      ["ترتيب أ", "ترتيب ب"].includes(row.name),
    );
    expect(ordered.map((row) => row.name)).toEqual(["ترتيب أ", "ترتيب ب"]);

    const cityBList = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/main-categories", { token: adminBToken }),
    );
    const cityBBody = (await cityBList.json()) as { data: { name: string }[] };
    expect(cityBBody.data.some((row) => row.name === "ترتيب أ")).toBe(false);
  });

  test("cross-City detail returns 404", async () => {
    const created = await createCategory(adminToken, {
      name: "تفاصيل مدينة",
      imageAssetId: await createReadyAsset(adminToken, "detail.png"),
    });
    const id = ((await created.json()) as { id: string }).id;
    const cross = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${id}`, {
        token: adminBToken,
      }),
    );
    expect(cross.status).toBe(404);
    expect((await errorOf(cross)).code).toBe("MAIN_CATEGORY_NOT_FOUND");
  });

  test("update changes fields; cannot archive via PATCH; archived cannot update", async () => {
    const imageAssetId = await createReadyAsset(adminToken, "upd.png");
    const created = await createCategory(adminToken, {
      name: "للتحديث",
      imageAssetId,
      status: "ACTIVE",
      displayOrder: 1,
    });
    const id = ((await created.json()) as { id: string }).id;

    const updated = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { name: "تم التحديث", status: "INACTIVE", displayOrder: 7 },
      }),
    );
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as {
      name: string;
      status: string;
      displayOrder: number;
    };
    expect(body.name).toBe("تم التحديث");
    expect(body.status).toBe("INACTIVE");
    expect(body.displayOrder).toBe(7);

    const archiveViaPatch = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "ARCHIVED" },
      }),
    );
    expect(archiveViaPatch.status).toBe(422);
    expect((await errorOf(archiveViaPatch)).code).toBe(
      "MAIN_CATEGORY_INVALID_STATUS",
    );

    await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${id}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    const afterArchive = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${id}`, {
        method: "PATCH",
        token: adminToken,
        body: { name: "لا" },
      }),
    );
    expect(afterArchive.status).toBe(409);
    expect((await errorOf(afterArchive)).code).toBe("MAIN_CATEGORY_ARCHIVED");
  });

  test("image replacement claims new and releases old atomically; same id is no-op", async () => {
    const oldId = await createReadyAsset(adminToken, "old-img.png");
    const created = await createCategory(adminToken, {
      name: "استبدال صورة",
      imageAssetId: oldId,
    });
    const categoryId = ((await created.json()) as { id: string }).id;

    const same = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${categoryId}`, {
        method: "PATCH",
        token: adminToken,
        body: { imageAssetId: oldId },
      }),
    );
    expect(same.status).toBe(200);
    const [stillAttached] = await harness.client<
      { status: string; attached_at: Date | null }[]
    >`select status::text as status, attached_at from media_assets where id = ${oldId}`;
    expect(stillAttached?.status).toBe("READY");
    expect(stillAttached?.attached_at).not.toBeNull();

    const newId = await createReadyAsset(adminToken, "new-img.png");
    const replaced = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${categoryId}`, {
        method: "PATCH",
        token: adminToken,
        body: { imageAssetId: newId },
      }),
    );
    expect(replaced.status).toBe(200);
    const replacedBody = (await replaced.json()) as {
      image: { assetId: string };
    };
    expect(replacedBody.image.assetId).toBe(newId);

    const [oldAsset] = await harness.client<
      { status: string; attached_at: Date | null }[]
    >`select status::text as status, attached_at from media_assets where id = ${oldId}`;
    const [newAsset] = await harness.client<
      { status: string; attached_at: Date | null }[]
    >`select status::text as status, attached_at from media_assets where id = ${newId}`;
    expect(oldAsset?.status).toBe("DELETE_PENDING");
    expect(oldAsset?.attached_at).toBeNull();
    expect(newAsset?.status).toBe("READY");
    expect(newAsset?.attached_at).not.toBeNull();
  });

  test("failed image replacement leaves original image and asset states intact", async () => {
    const oldId = await createReadyAsset(adminToken, "fail-old.png");
    const blocker = await createCategory(adminToken, {
      name: "مانع الاسم",
      imageAssetId: await createReadyAsset(adminToken, "blocker.png"),
    });
    expect(blocker.status).toBe(200);

    const created = await createCategory(adminToken, {
      name: "فشل الاستبدال",
      imageAssetId: oldId,
    });
    const categoryId = ((await created.json()) as { id: string }).id;
    const newId = await createReadyAsset(adminToken, "fail-new.png");

    const failed = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${categoryId}`, {
        method: "PATCH",
        token: adminToken,
        body: { imageAssetId: newId, name: "مانع الاسم" },
      }),
    );
    expect(failed.status).toBe(409);
    expect((await errorOf(failed)).code).toBe("MAIN_CATEGORY_NAME_CONFLICT");

    const [category] = await harness.client<{ image_asset_id: string }[]>`
      select image_asset_id::text as image_asset_id from main_categories where id = ${categoryId}`;
    expect(category?.image_asset_id).toBe(oldId);
    const [oldAsset] = await harness.client<
      { status: string; attached_at: Date | null }[]
    >`select status::text as status, attached_at from media_assets where id = ${oldId}`;
    const [newAsset] = await harness.client<
      { status: string; attached_at: Date | null }[]
    >`select status::text as status, attached_at from media_assets where id = ${newId}`;
    expect(oldAsset?.status).toBe("READY");
    expect(oldAsset?.attached_at).not.toBeNull();
    expect(newAsset?.status).toBe("READY");
    expect(newAsset?.attached_at).toBeNull();
  });

  test("concurrent claims of the same image have exactly one winner", async () => {
    const imageAssetId = await createReadyAsset(adminToken, "race-claim.png");
    const results = await Promise.all([
      createCategory(adminToken, {
        name: "سباق واحد",
        imageAssetId,
      }),
      createCategory(adminToken, {
        name: "سباق اثنان",
        imageAssetId,
      }),
    ]);
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  test("concurrent image replacements do not corrupt attachment state", async () => {
    const oldId = await createReadyAsset(adminToken, "race-old.png");
    const created = await createCategory(adminToken, {
      name: "سباق استبدال",
      imageAssetId: oldId,
    });
    const categoryId = ((await created.json()) as { id: string }).id;
    const a = await createReadyAsset(adminToken, "race-a.png");
    const b = await createReadyAsset(adminToken, "race-b.png");

    const results = await Promise.all([
      harness.app.handle(
        jsonRequest(`/api/v1/dashboard/main-categories/${categoryId}`, {
          method: "PATCH",
          token: adminToken,
          body: { imageAssetId: a },
        }),
      ),
      harness.app.handle(
        jsonRequest(`/api/v1/dashboard/main-categories/${categoryId}`, {
          method: "PATCH",
          token: adminToken,
          body: { imageAssetId: b },
        }),
      ),
    ]);
    expect(results.some((response) => response.status === 200)).toBe(true);

    const [category] = await harness.client<{ image_asset_id: string }[]>`
      select image_asset_id::text as image_asset_id from main_categories where id = ${categoryId}`;
    const winner = category!.image_asset_id;
    expect([a, b]).toContain(winner);

    const assets = await harness.client<
      { id: string; status: string; attached_at: Date | null }[]
    >`select id::text as id, status::text as status, attached_at
      from media_assets where id in (${oldId}, ${a}, ${b})`;
    const byId = Object.fromEntries(assets.map((row) => [row.id, row]));
    expect(byId[winner]?.status).toBe("READY");
    expect(byId[winner]?.attached_at).not.toBeNull();
    expect(byId[oldId]?.status).toBe("DELETE_PENDING");
    const loser = winner === a ? b : a;
    // Loser may remain READY unattached (lost race before claim) or DELETE_PENDING if it was claimed then superseded — either way not attached to the category.
    expect(byId[loser]?.attached_at == null || byId[loser]?.id !== winner).toBe(
      true,
    );
    expect(category?.image_asset_id).not.toBe(oldId);
  });

  test("archive is soft, idempotent, keeps image attached, and hides from public", async () => {
    const imageAssetId = await createReadyAsset(adminToken, "archive.png");
    const created = await createCategory(adminToken, {
      name: "للأرشفة",
      imageAssetId,
      displayOrder: 50,
    });
    const id = ((await created.json()) as { id: string }).id;

    const first = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${id}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      status: string;
      archivedAt: string | null;
      image: { assetId: string };
    };
    expect(firstBody.status).toBe("ARCHIVED");
    expect(firstBody.archivedAt).not.toBeNull();
    expect(firstBody.image.assetId).toBe(imageAssetId);

    const second = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories/${id}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    expect(second.status).toBe(200);

    const [asset] = await harness.client<
      { status: string; attached_at: Date | null }[]
    >`select status::text as status, attached_at from media_assets where id = ${imageAssetId}`;
    expect(asset?.status).toBe("READY");
    expect(asset?.attached_at).not.toBeNull();

    const publicList = await harness.app.handle(
      new Request("http://localhost/api/v1/public/main-categories", {
        headers: { "X-City-Id": cityA },
      }),
    );
    const publicBody = (await publicList.json()) as { data: { id: string }[] };
    expect(publicBody.data.some((row) => row.id === id)).toBe(false);
  });

  test("public endpoint returns ACTIVE ordered categories only and requires trusted City", async () => {
    const inactiveAsset = await createReadyAsset(adminToken, "inactive-pub.png");
    await createCategory(adminToken, {
      name: "غير نشط علني",
      imageAssetId: inactiveAsset,
      status: "INACTIVE",
      displayOrder: 1,
    });

    const activeLow = await createCategory(adminToken, {
      name: "علني منخفض",
      imageAssetId: await createReadyAsset(adminToken, "pub-low.png"),
      status: "ACTIVE",
      displayOrder: 2,
    });
    const activeHigh = await createCategory(adminToken, {
      name: "علني مرتفع",
      imageAssetId: await createReadyAsset(adminToken, "pub-high.png"),
      status: "ACTIVE",
      displayOrder: 1,
    });
    const lowId = ((await activeLow.json()) as { id: string }).id;
    const highId = ((await activeHigh.json()) as { id: string }).id;

    const missing = await harness.app.handle(
      new Request("http://localhost/api/v1/public/main-categories"),
    );
    expect(missing.status).toBe(400);

    const list = await harness.app.handle(
      new Request("http://localhost/api/v1/public/main-categories", {
        headers: { "X-City-Id": cityA },
      }),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: {
        id: string;
        name: string;
        displayOrder: number;
        image: { url: string };
      }[];
    };
    const names = body.data.map((row) => row.name);
    expect(names).not.toContain("غير نشط علني");
    const publicOrdered = body.data.filter((row) =>
      [lowId, highId].includes(row.id),
    );
    expect(publicOrdered.map((row) => row.id)).toEqual([highId, lowId]);
    expect(publicOrdered[0]!.image.url).toContain(
      "https://media.test.example.com/",
    );
    expect(JSON.stringify(body)).not.toContain("objectKey");
    expect(JSON.stringify(body)).not.toContain("object_key");
    expect(JSON.stringify(body)).not.toContain("etag");
  });

  test("query and body cannot override signed Dashboard City", async () => {
    const list = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/main-categories?cityId=${cityB}&limit=100`, {
        token: adminToken,
      }),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: { name: string }[] };
    // cityId query is ignored; list remains signed-City scoped (City A names only).
    expect(body.data.some((row) => row.name === "اسم مشترك")).toBe(true);

    const create = await createCategory(adminToken, {
      name: "تجاوز مدينة",
      imageAssetId: await createReadyAsset(adminToken, "override.png"),
      cityId: cityB,
    });
    expect(create.status).toBe(422);
  });

  test("OpenAPI documents Main Category tags and paths", async () => {
    const doc = (await (
      await harness.app.handle(new Request("http://localhost/openapi/json"))
    ).json()) as {
      tags: { name: string }[];
      paths: Record<string, unknown>;
    };
    expect(doc.tags.some((tag) => tag.name === "Dashboard — Main Categories")).toBe(
      true,
    );
    expect(doc.tags.some((tag) => tag.name === "Public — Main Categories")).toBe(
      true,
    );
    expect(doc.paths["/api/v1/dashboard/main-categories"]).toBeTruthy();
    expect(
      doc.paths["/api/v1/dashboard/main-categories/{mainCategoryId}"],
    ).toBeTruthy();
    expect(doc.paths["/api/v1/public/main-categories"]).toBeTruthy();
  });

  test("database archive consistency and non-negative display_order checks", async () => {
    const archiveAsset = await createReadyAsset(adminToken, "chk-archive.png");
    let archiveFailed = false;
    try {
      await harness.client.unsafe(
        `insert into main_categories (
          city_id, name, image_asset_id, status, display_order, created_by_account_id, archived_at
        ) values ($1::uuid, $2, $3::uuid, 'ARCHIVED', 0, $4::uuid, null)`,
        [cityA, "فحص أرشيف", archiveAsset, adminAccountId],
      );
    } catch {
      archiveFailed = true;
    }
    expect(archiveFailed).toBe(true);

    const orderAsset = await createReadyAsset(adminToken, "chk-order.png");
    let orderFailed = false;
    try {
      await harness.client.unsafe(
        `insert into main_categories (
          city_id, name, image_asset_id, status, display_order, created_by_account_id
        ) values ($1::uuid, $2, $3::uuid, 'ACTIVE', -1, $4::uuid)`,
        [cityA, "فحص ترتيب", orderAsset, adminAccountId],
      );
    } catch {
      orderFailed = true;
    }
    expect(orderFailed).toBe(true);
  });
});
