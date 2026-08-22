import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createActiveCity, createIntegrationHarness, createStaffAccount, jsonRequest, type IntegrationHarness } from "./helpers";

const password = "fixed staff password";
const pngBytes = Uint8Array.of(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,0x00,0x00,0x00,0x01,0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,0xde,0x00,0x00,0x00,0x0c,0x49,0x44,0x41,0x54,0x08,0xd7,0x63,0xf8,0xff,0xff,0x3f,0x00,0x05,0xfe,0x02,0xfe,0xdc,0xcc,0x59,0xe7,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82);
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string } }).error;

describe("M3-C1 Main Categories — SUPER_ADMIN explicit City contract", () => {
  let harness: IntegrationHarness, cityA = "", cityB = "", superToken = "", adminToken = "", superAccountId = "";
  const login = (email: string, requestId: string) => harness.auth.dashboard.login({ email, password, deviceName: requestId, ip: requestId, requestId });
  const queryCity = (path: string, cityId = cityA) => `${path}${path.includes("?") ? "&" : "?"}cityId=${cityId}`;
  const createReadyAsset = async (cityId = cityA, name = "category.png") => {
    const intent = await harness.app.handle(jsonRequest("/api/v1/dashboard/media/upload-intents", { method: "POST", token: superToken, body: { purpose: "CATEGORY_IMAGE", cityId, fileName: name, contentType: "image/png", sizeBytes: pngBytes.length } }));
    expect(intent.status).toBe(200);
    const payload = (await intent.json()) as { asset: { id: string } };
    const objectKey = await harness.media.getObjectKeyForTests(payload.asset.id, cityId);
    expect(objectKey).toBeTruthy();
    harness.mediaStorage.putObject(objectKey!, "image/png", pngBytes);
    const confirmed = await harness.app.handle(jsonRequest(queryCity(`/api/v1/dashboard/media/${payload.asset.id}/confirm`, cityId), { method: "POST", token: superToken }));
    expect(confirmed.status).toBe(200);
    return payload.asset.id;
  };
  const createCategory = (cityId: string, body: Record<string, unknown>, token = superToken) => harness.app.handle(jsonRequest("/api/v1/dashboard/main-categories", { method: "POST", token, body: { cityId, ...body } }));

  beforeAll(async () => {
    harness = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_m3c1" });
    cityA = await createActiveCity(harness.client, "Main category City A");
    cityB = await createActiveCity(harness.client, "Main category City B");
    superAccountId = await createStaffAccount(harness.auth, harness.client, { email: "m3c1-super@example.com", password, roles: ["SUPER_ADMIN"] });
    await createStaffAccount(harness.auth, harness.client, { email: "m3c1-admin@example.com", password, roles: ["ADMIN"], cityId: cityA });
    superToken = (await login("m3c1-super@example.com", "super")).access_token;
    adminToken = (await login("m3c1-admin@example.com", "admin")).access_token;
  });
  afterAll(async () => { await harness.close(); });

  test("SUPER_ADMIN creates a category in an explicit City and claims its CATEGORY_IMAGE", async () => {
    const imageAssetId = await createReadyAsset();
    const response = await createCategory(cityA, { name: "مطاعم", imageAssetId, status: "ACTIVE", displayOrder: 1 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { cityId: string; image: { assetId: string; url: string }; createdByAccountId: string; updatedByAccountId: string; archivedByAccountId: string | null };
    expect(body.cityId).toBe(cityA); expect(body.image.assetId).toBe(imageAssetId); expect(body.image.url).toContain("https://media.test.example.com/");
    expect(body.createdByAccountId).toBe(superAccountId); expect(body.updatedByAccountId).toBe(superAccountId); expect(body.archivedByAccountId).toBeNull();
    const [asset] = await harness.client<{ attached_at: Date | null }[]>`select attached_at from media_assets where id = ${imageAssetId}`;
    expect(asset?.attached_at).not.toBeNull();
  });

  test("Dashboard authorization and City selectors follow the new contract", async () => {
    const imageAssetId = await createReadyAsset();
    expect((await createCategory(cityA, { name: "منع المدير", imageAssetId }, adminToken)).status).toBe(403);
    expect((await harness.app.handle(jsonRequest("/api/v1/dashboard/main-categories", { method: "POST", token: superToken, body: { name: "بدون مدينة", imageAssetId } }))).status).toBe(422);
    expect((await harness.app.handle(jsonRequest("/api/v1/dashboard/main-categories?limit=10", { token: superToken }))).status).toBe(422);
    expect((await harness.app.handle(jsonRequest(queryCity("/api/v1/dashboard/main-categories", crypto.randomUUID()), { token: superToken }))).status).toBe(404);
  });

  test("DRAFT, ACTIVE, and SUSPENDED Cities are manageable; ARCHIVED is rejected", async () => {
    const draft = await createActiveCity(harness.client, "Draft main categories"), suspended = await createActiveCity(harness.client, "Suspended main categories"), archived = await createActiveCity(harness.client, "Archived main categories");
    await harness.client`update cities set status = 'DRAFT' where id = ${draft}`; await harness.client`update cities set status = 'SUSPENDED' where id = ${suspended}`; await harness.client`update cities set status = 'ARCHIVED', archived_at = now() where id = ${archived}`;
    for (const [cityId, name] of [[draft, "مسودة"], [suspended, "معلق"]] as const) {
      expect((await createCategory(cityId, { name, imageAssetId: await createReadyAsset(cityId, `${cityId}.png`) })).status).toBe(200);
    }
    const rejected = await createCategory(archived, { name: "مؤرشف", imageAssetId: crypto.randomUUID() });
    expect(rejected.status).toBe(409); expect((await errorOf(rejected)).code).toBe("CITY_ARCHIVED");
  });

  test("City isolation, detail, update, and archive require the selected City", async () => {
    const created = await createCategory(cityA, { name: "للتعديل", imageAssetId: await createReadyAsset(), displayOrder: 4 });
    const category = (await created.json()) as { id: string };
    const cross = await harness.app.handle(jsonRequest(queryCity(`/api/v1/dashboard/main-categories/${category.id}`, cityB), { token: superToken }));
    expect(cross.status).toBe(404); expect((await errorOf(cross)).code).toBe("MAIN_CATEGORY_NOT_FOUND");
    const updated = await harness.app.handle(jsonRequest(queryCity(`/api/v1/dashboard/main-categories/${category.id}`), { method: "PATCH", token: superToken, body: { name: "تم التحديث", displayOrder: 7 } }));
    expect(updated.status).toBe(200);
    const updateBody = (await updated.json()) as { createdByAccountId: string; updatedByAccountId: string };
    expect(updateBody.createdByAccountId).toBe(superAccountId); expect(updateBody.updatedByAccountId).toBe(superAccountId);
    const archived = await harness.app.handle(jsonRequest(queryCity(`/api/v1/dashboard/main-categories/${category.id}`), { method: "DELETE", token: superToken }));
    expect(archived.status).toBe(200);
    const archiveBody = (await archived.json()) as { status: string; archivedByAccountId: string; updatedByAccountId: string };
    expect(archiveBody.status).toBe("ARCHIVED"); expect(archiveBody.archivedByAccountId).toBe(superAccountId); expect(archiveBody.updatedByAccountId).toBe(superAccountId);
  });

  test("asset claim conflicts roll back and replacement is atomic", async () => {
    const image = await createReadyAsset(cityA, "claimed.png");
    expect((await createCategory(cityA, { name: "الأول", imageAssetId: image })).status).toBe(200);
    const duplicate = await createCategory(cityA, { name: "الثاني", imageAssetId: image });
    expect(duplicate.status).toBe(409); expect((await errorOf(duplicate)).code).toBe("MEDIA_NOT_ATTACHABLE");
    const oldAsset = await createReadyAsset(cityA, "old.png"), categoryResponse = await createCategory(cityA, { name: "استبدال", imageAssetId: oldAsset }), category = (await categoryResponse.json()) as { id: string }, newAsset = await createReadyAsset(cityA, "new.png");
    const replaced = await harness.app.handle(jsonRequest(queryCity(`/api/v1/dashboard/main-categories/${category.id}`), { method: "PATCH", token: superToken, body: { imageAssetId: newAsset } }));
    expect(replaced.status).toBe(200);
    const assets = await harness.client<{ id: string; status: string; attached_at: Date | null }[]>`select id::text, status::text, attached_at from media_assets where id in (${oldAsset}, ${newAsset})`;
    const byId = Object.fromEntries(assets.map((row) => [row.id, row]));
    expect(byId[oldAsset]?.status).toBe("DELETE_PENDING"); expect(byId[oldAsset]?.attached_at).toBeNull(); expect(byId[newAsset]?.status).toBe("READY"); expect(byId[newAsset]?.attached_at).not.toBeNull();
  });

  test("Public main categories remain City-header scoped and do not expose actor IDs", async () => {
    const active = await createCategory(cityA, { name: "علني", imageAssetId: await createReadyAsset(), status: "ACTIVE", displayOrder: 1 });
    const activeId = ((await active.json()) as { id: string }).id;
    await createCategory(cityA, { name: "غير علني", imageAssetId: await createReadyAsset(), status: "INACTIVE", displayOrder: 0 });
    const response = await harness.app.handle(new Request("http://localhost/api/v1/public/main-categories", { headers: { "X-City-Id": cityA } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string; name: string }> };
    expect(body.data.some((row) => row.id === activeId)).toBe(true); expect(body.data.some((row) => row.name === "غير علني")).toBe(false); expect(JSON.stringify(body)).not.toContain("ByAccountId");
  });

  test("OpenAPI documents the same Dashboard and Public paths", async () => {
    const doc = (await (await harness.app.handle(new Request("http://localhost/openapi/json"))).json()) as { paths: Record<string, unknown> };
    expect(doc.paths["/api/v1/dashboard/main-categories"]).toBeTruthy(); expect(doc.paths["/api/v1/dashboard/main-categories/{mainCategoryId}"]).toBeTruthy(); expect(doc.paths["/api/v1/public/main-categories"]).toBeTruthy();
  });
});
