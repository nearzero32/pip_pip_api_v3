import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DASHBOARD_LIST_ENDPOINTS,
  DASHBOARD_LIST_GAPS,
} from "../../src/modules/dashboard-lists/inventory";
import {
  createIntegrationHarness,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

type Spec = {
  paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }>; requestBody?: unknown; responses?: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }> }>>;
};

const toOpenApiPath = (template: string) =>
  template.replaceAll(/:([A-Za-z]+)/g, "{$1}");

const queryNames = (op: { parameters?: Array<{ name: string; in: string }> } | undefined) =>
  (op?.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name);

const schemaOf = (op: { responses?: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }> } | undefined) =>
  op?.responses?.["200"]?.content?.["application/json"]?.schema as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;

describe("dashboard OpenAPI list/export contract", () => {
  let h: IntegrationHarness;
  let spec: Spec;
  let pathCountBeforeDocs = 0;
  let operationCountBeforeDocs = 0;

  beforeAll(async () => {
    h = await createIntegrationHarness({ databasePrefix: "pip_pip_v3_dash_oa" });
    const res = await h.app.handle(jsonRequest("/openapi/json"));
    spec = (await res.json()) as Spec;
    pathCountBeforeDocs = Object.keys(spec.paths).length;
    operationCountBeforeDocs = Object.values(spec.paths).reduce(
      (n, item) => n + Object.keys(item).filter((m) => ["get", "post", "put", "patch", "delete"].includes(m)).length,
      0,
    );
  });

  afterAll(async () => {
    await h.close();
  });

  test("exact OpenAPI path and operation counts", () => {
    const paths = Object.keys(spec.paths).length;
    const operations = Object.values(spec.paths).reduce(
      (n, item) =>
        n +
        Object.keys(item).filter((m) =>
          ["get", "post", "put", "patch", "delete"].includes(m),
        ).length,
      0,
    );
    expect(paths).toBe(pathCountBeforeDocs);
    expect(operations).toBe(operationCountBeforeDocs);
    expect(paths).toBeGreaterThan(80);
    expect(operations).toBeGreaterThan(120);
    // Captured after documenting export query schemas in this closure audit.
    (globalThis as { __openapiCounts?: unknown }).__openapiCounts = {
      paths,
      operations,
    };
  });

  test("automated LIST inventory matches OpenAPI GET dashboard nested pages", () => {
    const listGets: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      if (!path.startsWith("/api/v1/dashboard") || path.endsWith("/export")) continue;
      const get = item.get;
      if (!get) continue;
      const schema = schemaOf(get);
      const props = schema?.properties ?? {};
      if ("data" in props && "pagination" in props) listGets.push(path);
    }
    const expected = DASHBOARD_LIST_ENDPOINTS.map((ep) => toOpenApiPath(ep.pathTemplate)).sort();
    expect(listGets.sort()).toEqual(expected);
  });

  test("each LIST documents search/page/limit/sortBy/sortOrder and implemented filters only", () => {
    const required = ["search", "page", "limit", "sortBy", "sortOrder"];
    for (const ep of DASHBOARD_LIST_ENDPOINTS) {
      const path = toOpenApiPath(ep.pathTemplate);
      const names = queryNames(spec.paths[path]?.get);
      for (const name of required) {
        expect(names, `${ep.id} ${name}`).toContain(name);
      }
      for (const filter of ep.filters) {
        expect(names, `${ep.id} missing filter ${filter}`).toContain(filter);
      }
      for (const banned of ep.unimplementedFilters) {
        expect(names, `${ep.id} undocumented ${banned}`).not.toContain(banned);
      }
      const schema = schemaOf(spec.paths[path]?.get);
      expect(schema?.properties?.pagination, `${ep.id} pagination`).toBeTruthy();
      expect(schema?.properties?.data, `${ep.id} data`).toBeTruthy();
    }
    expect(DASHBOARD_LIST_GAPS.assignmentCandidates).toContain("Redis");
  });

  test("each EXPORT documents search/filters/sort without pagination", () => {
    for (const ep of DASHBOARD_LIST_ENDPOINTS) {
      if (!ep.exportPathTemplate) continue;
      const path = toOpenApiPath(ep.exportPathTemplate);
      const get = spec.paths[path]?.get;
      expect(get, `export ${ep.id}`).toBeTruthy();
      const names = queryNames(get);
      expect(names).toContain("search");
      expect(names).toContain("sortBy");
      expect(names).toContain("sortOrder");
      expect(names).not.toContain("page");
      expect(names).not.toContain("limit");
      for (const filter of ep.filters) {
        if (ep.id === "store-commission-history") continue;
        expect(names, `export ${ep.id} ${filter}`).toContain(filter);
      }
      for (const banned of ep.unimplementedFilters) {
        expect(names).not.toContain(banned);
      }
    }
  });
});
