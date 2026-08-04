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
import type { MediaService } from "./modules/media/media.service";
import { mediaRoutes } from "./modules/media/media.routes";
import type { MainCategoryService } from "./modules/catalog/main-category.service";
import { mainCategoryRoutes } from "./modules/catalog/main-category.routes";

export interface AppDependencies extends HealthDependencies {
  logger: Logger;
  production: boolean;
  authModule?: AuthModule;
  geographyService?: GeographyService;
  mediaService?: MediaService;
  mainCategoryService?: MainCategoryService;
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
          { name: "Dashboard — Staff", description: "SUPER_ADMIN ADMIN management and ADMIN employee management" },
          { name: "Dashboard — Governorates", description: "Governorate administration" },
          { name: "Dashboard — Cities", description: "City administration" },
          {
            name: "Dashboard — Zones",
            description:
              "City-scoped Zone administration for ADMIN and granted employees. SUPER_ADMIN has no Zone access.",
          },
          {
            name: "Dashboard — Media",
            description:
              "City-scoped media upload intents, confirmation, and deletion for ADMIN and granted employees. SUPER_ADMIN has no Media access. Direct browser-to-R2 uploads via short-lived presigned PUT URLs.",
          },
          {
            name: "Dashboard — Main Categories",
            description:
              "City-scoped Main Category administration for ADMIN and granted employees. SUPER_ADMIN has no Main Category access. Images are mandatory CATEGORY_IMAGE media assets.",
          },
          {
            name: "Public — Geography",
            description:
              "Unauthenticated geography reads for pre-login City selection and City-scoped Zone lookup via X-City-Id",
          },
          {
            name: "Public — Main Categories",
            description:
              "Unauthenticated Main Category catalog for the City selected by X-City-Id",
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          },
          parameters: {
            CityIdHeader: {
              name: "X-City-Id",
              in: "header",
              required: true,
              description:
                "Canonical public/mobile City selection header. UUID of an ACTIVE City under an ACTIVE Governorate. Not an authentication credential and never overrides Dashboard signed City scope.",
              schema: { type: "string", format: "uuid" },
            },
          },
        },
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
    .use(dependencies.authModule && dependencies.geographyService ? geographyRoutes(dependencies.authModule, dependencies.geographyService) : new Elysia())
    .use(dependencies.authModule && dependencies.mediaService ? mediaRoutes(dependencies.authModule, dependencies.mediaService) : new Elysia())
    .use(
      dependencies.authModule && dependencies.mainCategoryService
        ? mainCategoryRoutes(dependencies.authModule, dependencies.mainCategoryService)
        : new Elysia(),
    );
}
