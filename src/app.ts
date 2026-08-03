import { openapi } from "@elysiajs/openapi";
import { Elysia, status } from "elysia";
import { AppError } from "./errors/app-error";
import { healthRoutes, type HealthDependencies } from "./health/routes";
import type { Logger } from "./observability/logger";
import { resolveRequestId } from "./shared/request-id";
import type { AuthModule } from "./modules/auth/auth-module";
import { authRoutes } from "./modules/auth/routes";
import type { GeographyService } from "./modules/geography/service";
import { geographyRoutes } from "./modules/geography/routes";

export interface AppDependencies extends HealthDependencies {
  logger: Logger;
  production: boolean;
  authModule?: AuthModule;
  geographyService?: GeographyService;
}

export function createApp(dependencies: AppDependencies) {
  return new Elysia({ name: "pip-pip-api-v3" })
    .use(openapi({
      path: "/openapi",
      specPath: "/openapi/json",
      documentation: {
        info: { title: "pip_pip_api_v3", version: "0.2.0", description: "Identity, authentication, and session security API" },
        tags: [
          { name: "Health", description: "Runtime health probes" },
          { name: "Mobile — Customer Authentication", description: "Customer phone OTP authentication" },
          { name: "Mobile — Driver Authentication", description: "Driver phone and numeric access-code authentication" },
          { name: "Dashboard — Authentication", description: "Dashboard email and password authentication" },
          { name: "Dashboard — Governorates", description: "Governorate administration" },
          { name: "Dashboard — Cities", description: "City administration" },
          {
            name: "Public — Geography",
            description:
              "Unauthenticated geography reads for pre-login City selection (active cities under active governorates only)",
          },
        ],
        components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
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
    .onError(({ error, code, request, requestId, set }) => {
      const path = new URL(request.url, "http://localhost").pathname;
      if (error instanceof AppError) {
        if (error.retryAfterSeconds) set.headers["retry-after"] = String(error.retryAfterSeconds);
        dependencies.logger.warn({ event: "request_error", code: error.publicCode, path, request_id: requestId });
        return status(error.statusCode, { error: { code: error.publicCode, message: error.message }, request_id: requestId });
      }
      if (code === "NOT_FOUND") {
        return status(404, { error: { code: "NOT_FOUND", message: "Resource not found" }, request_id: requestId });
      }
      if (code === "VALIDATION") {
        return status(422, { error: { code: "VALIDATION_FAILED", message: "The request is invalid" }, request_id: requestId });
      }
      if (code === "PARSE") {
        return status(422, { error: { code: "VALIDATION_FAILED", message: "The request is invalid" }, request_id: requestId });
      }
      dependencies.logger.error({ event: "unexpected_error", path, request_id: requestId, error_name: error instanceof Error ? error.name : "UnknownError" });
      return status(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
        request_id: requestId,
      });
    })
    .use(healthRoutes(dependencies))
    .use(dependencies.authModule ? authRoutes(dependencies.authModule) : new Elysia())
    .use(dependencies.authModule && dependencies.geographyService ? geographyRoutes(dependencies.authModule, dependencies.geographyService) : new Elysia());
}
