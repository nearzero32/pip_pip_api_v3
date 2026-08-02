import { openapi } from "@elysiajs/openapi";
import { Elysia, status } from "elysia";
import { AppError } from "./errors/app-error";
import { healthRoutes, type HealthDependencies } from "./health/routes";
import type { Logger } from "./observability/logger";
import { resolveRequestId } from "./shared/request-id";

export interface AppDependencies extends HealthDependencies {
  logger: Logger;
  production: boolean;
}

export function createApp(dependencies: AppDependencies) {
  return new Elysia({ name: "pip-pip-api-v3" })
    .use(openapi({
      path: "/openapi",
      specPath: "/openapi/json",
      documentation: {
        info: { title: "pip_pip_api_v3", version: "0.1.0", description: "M1 Project Foundation and Identity Database Foundation" },
        tags: [{ name: "Health", description: "Runtime health probes" }],
      },
    }))
    .derive(({ request, set }) => {
      const requestId = resolveRequestId(request.headers.get("x-request-id"));
      set.headers["x-request-id"] = requestId;
      return { requestId, requestPath: new URL(request.url).pathname, requestStartedAt: performance.now() };
    })
    .onAfterResponse(({ request, set, requestId, requestPath, requestStartedAt }) => {
      dependencies.logger.info({
        event: "http_request_completed",
        method: request.method,
        path: requestPath,
        status: typeof set.status === "number" ? set.status : 200,
        request_id: requestId,
        duration_ms: Math.round((performance.now() - requestStartedAt) * 100) / 100,
      });
    })
    .onError(({ error, code, request, requestId }) => {
      const path = new URL(request.url, "http://localhost").pathname;
      if (error instanceof AppError) {
        dependencies.logger.warn({ event: "request_error", code: error.publicCode, path, request_id: requestId });
        return status(error.statusCode, { error: { code: error.publicCode, message: error.message }, request_id: requestId });
      }
      if (code === "NOT_FOUND") {
        return status(404, { error: { code: "NOT_FOUND", message: "Resource not found" }, request_id: requestId });
      }
      dependencies.logger.error({ event: "unexpected_error", path, request_id: requestId, error_name: error instanceof Error ? error.name : "UnknownError" });
      return status(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
        request_id: requestId,
      });
    })
    .use(healthRoutes(dependencies));
}
