import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createActiveCity, createIntegrationHarness, createStaffAccount, jsonRequest, type IntegrationHarness } from "./helpers";

const password = "fixed staff password";
const pngBytes = Uint8Array.of(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,0x00,0x00,0x00,0x01,0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,0xde,0x00,0x00,0x00,0x0c,0x49,0x44,0x41,0x54,0x08,0xd7,0x63,0xf8,0xff,0xff,0x3f,0x00,0x05,0xfe,0x02,0xfe,0xdc,0xcc,0x59,0xe7,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82);
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string } }).error;

describe("M3-C0 CATEGORY_IMAGE Media — SUPER_ADMIN explicit City contract", () => {
  let h: IntegrationHarness, cityA = "", cityB = "", superToken = "", adminToken = "";
  const target = (path: string, cityId = cityA) => `${path}${path.includes("?") ? "&" : "?"}cityId=${cityId}`;
  const intent = (cityId = cityA, token = superToken, body: Record<string, unknown> = {}) => h.app.handle(jsonRequest("/api/v1/dashboard/media/upload-intents", { method: "POST", token, body: { purpose: "CATEGORY_IMAGE", cityId, fileName: "image.png", contentType: "image/png", sizeBytes: pngBytes.length, ...body } }));
  const ready = async (cityId = cityA) => {
    const response = await intent(cityId); expect(response.status).toBe(200);
    const assetId = ((await response.json()) as { asset: { id: string } }).asset.id;
    const key = await h.media.getObjectKeyForTests(assetId, cityId); expect(key).toContain(`cities/${cityId}/categories/`);
    h.mediaStorage.putObject(key!, "image/png", pngBytes);
    const confirmed = await h.app.handle(jsonRequest(target(`/api/v1/dashboard/media/${assetId}/confirm`, cityId), { method: "POST", token: superToken }));
    expect(confirmed.status).toBe(200); return assetId;
  };
  beforeAll(async () => {
    h = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_m3c0" }); cityA = await createActiveCity(h.client, "Media City A"); cityB = await createActiveCity(h.client, "Media City B");
    await createStaffAccount(h.auth, h.client, { email: "m3c0-super@example.com", password, roles: ["SUPER_ADMIN"] });
    await createStaffAccount(h.auth, h.client, { email: "m3c0-admin@example.com", password, roles: ["ADMIN"], cityId: cityA });
    superToken = (await h.auth.dashboard.login({ email: "m3c0-super@example.com", password, deviceName: "super", ip: "super", requestId: "super" })).access_token;
    adminToken = (await h.auth.dashboard.login({ email: "m3c0-admin@example.com", password, deviceName: "admin", ip: "admin", requestId: "admin" })).access_token;
  });
  afterAll(async () => { await h.close(); });

  test("SUPER_ADMIN creates CATEGORY_IMAGE only with an explicit valid City", async () => {
    expect((await intent()).status).toBe(200);
    expect((await h.app.handle(jsonRequest("/api/v1/dashboard/media/upload-intents", { method: "POST", token: superToken, body: { purpose: "CATEGORY_IMAGE", fileName: "x.png", contentType: "image/png", sizeBytes: pngBytes.length } }))).status).toBe(422);
    expect((await intent(cityA, adminToken)).status).toBe(403);
    expect((await intent(crypto.randomUUID())).status).toBe(404);
    await h.client`update cities set status='ARCHIVED', archived_at=now() where id=${cityB}`;
    const archived = await intent(cityB); expect(archived.status).toBe(409); expect((await errorOf(archived)).code).toBe("CITY_ARCHIVED");
  });

  test("confirm, read, and deletion retain City isolation", async () => {
    await h.client`update cities set status='ACTIVE', archived_at=null where id=${cityB}`;
    const assetId = await ready();
    const read = await h.app.handle(jsonRequest(target(`/api/v1/dashboard/media/${assetId}`), { token: superToken })); expect(read.status).toBe(200);
    const cross = await h.app.handle(jsonRequest(target(`/api/v1/dashboard/media/${assetId}`, cityB), { token: superToken })); expect(cross.status).toBe(404);
    const deleted = await h.app.handle(jsonRequest(target(`/api/v1/dashboard/media/${assetId}`), { method: "DELETE", token: superToken })); expect(deleted.status).toBe(202);
    const repeated = await h.app.handle(jsonRequest(target(`/api/v1/dashboard/media/${assetId}`), { method: "DELETE", token: superToken })); expect(repeated.status).toBe(202);
  });

  test("SUPER_ADMIN cannot use the category bridge for another media purpose", async () => {
    const id = crypto.randomUUID();
    await h.client`insert into media_assets (id,city_id,purpose,visibility,status,object_key,original_name,expected_content_type,expected_size_bytes,created_by_account_id,upload_expires_at) values (${id},${cityA},'STORE_LOGO','PUBLIC','PENDING_UPLOAD',${`cities/${cityA}/stores/${id}/logo.png`},'logo.png','image/png',${pngBytes.length},(select account_id from account_emails where email_normalized='m3c0-super@example.com'),now()+interval '1 hour')`;
    const response = await h.app.handle(jsonRequest(target(`/api/v1/dashboard/media/${id}`), { token: superToken }));
    expect(response.status).toBe(404);
  });

  test("rejects unknown fields and preserves the Media OpenAPI paths", async () => {
    const invalid = await intent(cityA, superToken, { objectKey: "forbidden" }); expect(invalid.status).toBe(422);
    const doc = (await (await h.app.handle(new Request("http://localhost/openapi/json"))).json()) as { paths: Record<string, unknown> };
    expect(doc.paths["/api/v1/dashboard/media/upload-intents"]).toBeTruthy(); expect(doc.paths["/api/v1/dashboard/media/{assetId}/confirm"]).toBeTruthy();
  });
});
