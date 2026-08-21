import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createActiveCity, createIntegrationHarness, createStaffAccount, jsonRequest, type IntegrationHarness } from "./helpers";

const password = "fixed staff password";
const square = (x: number, y: number, size = .4) => ({ type: "Polygon" as const, coordinates: [[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]]] });
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

describe("M3-B1 Zones — SUPER_ADMIN explicit City contract", () => {
  let h: IntegrationHarness, active = "", draft = "", suspended = "", archived = "", other = "";
  let superToken = "", superId = "", adminToken = "", employeeToken = "";
  const request = (path: string, init: { method?: string; token?: string; body?: Record<string, unknown> } = {}, cityId = active) => {
    const method = init.method ?? (init.body ? "POST" : "GET");
    if (path === "/api/v1/dashboard/zones" && method === "POST")
      return jsonRequest(path, { ...init, method, body: { cityId, ...init.body } });
    const u = new URL(`http://localhost${path}`); u.searchParams.set("cityId", cityId);
    return jsonRequest(u.pathname + u.search, { ...init, method });
  };
  const create = (name: string, boundary: unknown, cityId = active, token = superToken) => h.app.handle(request("/api/v1/dashboard/zones", { method: "POST", token, body: { name, boundary } }, cityId));
  const login = (email: string) => h.auth.dashboard.login({ email, password, deviceName: email, ip: "test", requestId: crypto.randomUUID() });

  beforeAll(async () => {
    h = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_m3b1_super" });
    active = await createActiveCity(h.client, "Zones Active"); draft = await createActiveCity(h.client, "Zones Draft");
    suspended = await createActiveCity(h.client, "Zones Suspended"); archived = await createActiveCity(h.client, "Zones Archived"); other = await createActiveCity(h.client, "Zones Other");
    await h.client`update cities set status='DRAFT' where id=${draft}`;
    await h.client`update cities set status='SUSPENDED' where id=${suspended}`;
    await h.client`update cities set status='ARCHIVED', archived_at=now() where id=${archived}`;
    superId = await createStaffAccount(h.auth, h.client, { email: "zones-super@example.com", password, roles: ["SUPER_ADMIN"] });
    const adminId = await createStaffAccount(h.auth, h.client, { email: "zones-admin@example.com", password, roles: ["ADMIN"], cityId: active });
    const employee = await createStaffAccount(h.auth, h.client, { email: "zones-ops@example.com", password, roles: ["OPERATIONS"], cityId: active, managedByAccountId: adminId });
    await h.client`insert into account_permission_grants(account_id,permission_id,granted_by_account_id)
      select ${employee},id,${superId} from permissions where code='zones.read'`;
    superToken = (await login("zones-super@example.com")).access_token;
    adminToken = (await login("zones-admin@example.com")).access_token;
    employeeToken = (await login("zones-ops@example.com")).access_token;
  });
  afterAll(async () => { await h.close(); });

  test("PostGIS Polygon 4326 and GIST index exist", async () => {
    const [r] = await h.client<{ typmod: string; indexdef: string }[]>`select format_type(a.atttypid,a.atttypmod) typmod,i.indexdef from pg_attribute a join pg_class c on c.oid=a.attrelid cross join lateral(select indexdef from pg_indexes where tablename='zones' and indexname='zones_boundary_gix') i where c.relname='zones' and a.attname='boundary'`;
    expect(r?.typmod).toContain("Polygon,4326"); expect(r?.indexdef.toLowerCase()).toContain("using gist");
  });

  test("SUPER_ADMIN creates, lists, gets, updates and archives with the correct selector", async () => {
    const made = await create("contract", square(40, 20)); expect(made.status).toBe(200);
    const zone = await made.json() as { id: string; cityId: string; boundary: { type: string } }; expect(zone.cityId).toBe(active); expect(zone.boundary.type).toBe("Polygon");
    expect((await h.app.handle(request("/api/v1/dashboard/zones", { token: superToken }))).status).toBe(200);
    expect((await h.app.handle(request(`/api/v1/dashboard/zones/${zone.id}`, { token: superToken }))).status).toBe(200);
    expect((await h.app.handle(request(`/api/v1/dashboard/zones/${zone.id}`, { method: "PATCH", token: superToken, body: { name: "renamed" } }))).status).toBe(200);
    expect((await h.app.handle(request(`/api/v1/dashboard/zones/${zone.id}`, { method: "DELETE", token: superToken }))).status).toBe(200);
  });

  test("DRAFT, ACTIVE and SUSPENDED operate; ARCHIVED is rejected", async () => {
    for (const [cityId, x] of [[draft,42],[active,44],[suspended,46]] as const) {
      const made = await create(`state-${x}`, square(x,20), cityId); expect(made.status).toBe(200);
      const id = (await made.json() as { id: string }).id;
      expect((await h.app.handle(request(`/api/v1/dashboard/zones/${id}`, { method:"PATCH", token:superToken, body:{status:"INACTIVE"} }, cityId))).status).toBe(200);
      expect((await h.app.handle(request(`/api/v1/dashboard/zones/${id}`, { method:"DELETE", token:superToken }, cityId))).status).toBe(200);
    }
    const denied = await create("archived", square(48,20), archived); expect(denied.status).toBe(409); expect(await code(denied)).toBe("CITY_ARCHIVED");
  });

  test("boundary policy preserves legacy non-geometric operations", async () => {
    await h.client`update cities set boundary=null where id=${draft}`;
    const missing = await create("no-boundary", square(50,20), draft); expect(missing.status).toBe(409); expect(await code(missing)).toBe("CITY_BOUNDARY_REQUIRED");
    const [legacy] = await h.client<{ id: string }[]>`insert into zones(city_id,name,boundary,status) values(${draft},'legacy',ST_GeomFromText('POLYGON((51 20,51.4 20,51.4 20.4,51 20.4,51 20))',4326),'ACTIVE') returning id::text id`;
    expect((await h.app.handle(request(`/api/v1/dashboard/zones/${legacy!.id}`, { token:superToken }, draft))).status).toBe(200);
    expect((await h.app.handle(request(`/api/v1/dashboard/zones/${legacy!.id}`, { method:"PATCH", token:superToken, body:{name:"legacy-2"} }, draft))).status).toBe(200);
    expect((await h.app.handle(request(`/api/v1/dashboard/zones/${legacy!.id}`, { method:"DELETE", token:superToken }, draft))).status).toBe(200);
    await h.client`update cities set boundary=ST_GeomFromText('MULTIPOLYGON(((0 0,179 0,179 89,0 89,0 0)))',4326) where id=${draft}`;
  });

  test("ADMIN and historical employee grants cannot use any Dashboard Zone operation", async () => {
    const zone = await create("auth-target", square(52,20)); const id = (await zone.json() as { id:string }).id;
    for (const token of [adminToken, employeeToken]) {
      expect((await create("denied", square(53,20), active, token)).status).toBe(403);
      expect((await h.app.handle(request("/api/v1/dashboard/zones", {token}))).status).toBe(403);
      expect((await h.app.handle(request(`/api/v1/dashboard/zones/${id}`, {token}))).status).toBe(403);
      expect((await h.app.handle(request(`/api/v1/dashboard/zones/${id}`, {method:"PATCH",token,body:{name:"x"}}))).status).toBe(403);
      expect((await h.app.handle(request(`/api/v1/dashboard/zones/${id}`, {method:"DELETE",token}))).status).toBe(403);
    }
    expect((await h.app.handle(request("/api/v1/dashboard/zones", {}))).status).toBe(401);
  });

  test("missing/invalid selector, body reassignment and cross-City IDs have structured errors", async () => {
    expect((await h.app.handle(jsonRequest("/api/v1/dashboard/zones", {method:"POST",token:superToken,body:{name:"x",boundary:square(54,20)}}))).status).toBe(422);
    expect((await h.app.handle(jsonRequest("/api/v1/dashboard/zones?cityId=no", {token:superToken}))).status).toBe(422);
    const made = await create("other", square(55,20), other); const id = (await made.json() as {id:string}).id;
    const mismatch = await h.app.handle(request(`/api/v1/dashboard/zones/${id}`, {token:superToken}, active)); expect(mismatch.status).toBe(404); expect(await code(mismatch)).toBe("ZONE_NOT_FOUND");
    const patch = await h.app.handle(request(`/api/v1/dashboard/zones/${id}`, {method:"PATCH",token:superToken,body:{cityId:active}}, other)); expect(patch.status).toBe(422);
  });

  test("geometry validity, overlap rejection and touching acceptance remain intact", async () => {
    const base = await create("base", square(60,20,1)); expect(base.status).toBe(200);
    expect((await create("touch", square(61,20,1))).status).toBe(200);
    const overlap = await create("overlap", square(60.5,20.5,1)); expect(overlap.status).toBe(409); expect(await code(overlap)).toBe("ZONE_BOUNDARY_OVERLAP");
    const invalid = await create("bad", {type:"Polygon",coordinates:[[[60,20],[61,21],[60,21],[61,20],[60,20]] ]}); expect(invalid.status).toBe(400);
  });

  test("actor attribution and append-only audit are transactional", async () => {
    const made = await create("actor", square(70,20)); const zone = await made.json() as {id:string;createdByAccountId:string;updatedByAccountId:string;archivedByAccountId:null};
    expect(zone.createdByAccountId).toBe(superId); expect(zone.updatedByAccountId).toBe(superId); expect(zone.archivedByAccountId).toBeNull();
    expect((await h.app.handle(request(`/api/v1/dashboard/zones/${zone.id}`, {method:"PATCH",token:superToken,body:{boundary:square(70,20,.5)}}))).status).toBe(200);
    const rejected = await create("reject-audit", square(70.1,20.2,.2)); expect(rejected.status).toBe(409);
    expect((await h.app.handle(request(`/api/v1/dashboard/zones/${zone.id}`, {method:"DELETE",token:superToken}))).status).toBe(200);
    expect((await h.app.handle(request(`/api/v1/dashboard/zones/${zone.id}`, {method:"DELETE",token:superToken}))).status).toBe(200);
    const rows = await h.client<{event_type:string;actor:string;meta:Record<string,unknown>}[]>`select event_type,actor_account_id::text actor,redacted_metadata meta from audit_logs where target_id=${zone.id} order by occurred_at`;
    const metadata = rows.map(r => typeof (r.meta as unknown) === "string" ? JSON.parse(r.meta as unknown as string) as Record<string, unknown> : r.meta);
    expect(rows.map(r=>r.event_type)).toEqual(["ZONE_CREATED","ZONE_UPDATED","ZONE_ARCHIVED"]); expect(rows.every(r=>r.actor===superId)).toBe(true); expect(metadata.every(m=>m.targetCityId===active&&m.zoneId===zone.id)).toBe(true); expect(metadata[1]!.boundaryChanged).toBe(true); expect(JSON.stringify(metadata)).not.toContain("coordinates");
    const count = rows.length;
    const [after] = await h.client<{n:string}[]>`select count(*)::text n from audit_logs where target_id=${zone.id}`; expect(Number(after!.n)).toBe(count);
  });

  test("Public remains X-City-Id scoped, active-only, without actor IDs, and resolves points", async () => {
    expect((await create("public", square(80,20,1))).status).toBe(200);
    const list = await h.app.handle(jsonRequest("/api/v1/public/zones", {headers:{"X-City-Id":active}})); expect(list.status).toBe(200);
    const body = await list.json() as {data:Array<Record<string,unknown>>}; expect(body.data.some(z=>z.name==="public"&&!("createdByAccountId" in z))).toBe(true);
    const ignored = await h.app.handle(jsonRequest(`/api/v1/public/zones?cityId=${other}`, {headers:{"X-City-Id":active}})); expect(ignored.status).toBe(200); expect(((await ignored.json()) as {data:Array<{name:string}>}).data.some(z=>z.name==="public")).toBe(true);
    expect((await h.app.handle(jsonRequest("/api/v1/public/zones/resolve?longitude=80.5&latitude=20.5", {headers:{"X-City-Id":active}}))).status).toBe(200);
  });
});
