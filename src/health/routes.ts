import { Elysia, status } from "elysia";

export interface HealthDependencies {
  readinessCheck(): Promise<void>;
  redisReadinessCheck?(): Promise<void>;
}

export function healthRoutes(dependencies: HealthDependencies) {
  return new Elysia({ prefix: "/health" })
    .get("/live", () => ({ status: "ok", service: "pip_pip_api_v3" }), {
      detail: { tags: ["Health"], summary: "Liveness probe" },
    })
    .get("/ready", async () => {
      try { await dependencies.readinessCheck(); }
      catch { return status(503, { status: "not_ready", checks: { database: "down", ...(dependencies.redisReadinessCheck ? { redis: "unknown" } : {}) } }); }
      if (dependencies.redisReadinessCheck) {
        try { await dependencies.redisReadinessCheck(); }
        catch { return status(503, { status: "not_ready", checks: { database: "up", redis: "down" } }); }
        return { status: "ready", checks: { database: "up", redis: "up" } };
      }
      return { status: "ready", checks: { database: "up" } };
    }, { detail: { tags: ["Health"], summary: "Readiness probe" } });
}
