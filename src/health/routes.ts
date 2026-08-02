import { Elysia, status } from "elysia";

export interface HealthDependencies {
  readinessCheck(): Promise<void>;
}

export function healthRoutes(dependencies: HealthDependencies) {
  return new Elysia({ prefix: "/health" })
    .get("/live", () => ({ status: "ok", service: "pip_pip_api_v3" }), {
      detail: { tags: ["Health"], summary: "Liveness probe" },
    })
    .get("/ready", async () => {
      try {
        await dependencies.readinessCheck();
        return { status: "ready", checks: { database: "up" } };
      } catch {
        return status(503, { status: "not_ready", checks: { database: "down" } });
      }
    }, { detail: { tags: ["Health"], summary: "Readiness probe" } });
}
