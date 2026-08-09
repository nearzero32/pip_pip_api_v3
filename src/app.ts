import { Elysia, status } from "elysia";
import { AppError } from "./errors/app-error";
import { healthRoutes, type HealthDependencies } from "./health/routes";
import type { Logger } from "./observability/logger";
import { createOpenApiPlugin } from "./openapi";
import { resolveRequestId } from "./shared/request-id";
import type { AuthModule } from "./modules/auth/auth-module";
import { authRoutes } from "./modules/auth/routes";
import type { GeographyService } from "./modules/geography/service";
import { geographyRoutes } from "./modules/geography/routes";
import type { MediaService } from "./modules/media/media.service";
import { mediaRoutes } from "./modules/media/media.routes";
import type { MainCategoryService } from "./modules/catalog/main-category.service";
import { mainCategoryRoutes } from "./modules/catalog/main-category.routes";
import type { SubcategoryService } from "./modules/catalog/subcategory.service";
import { subcategoryRoutes } from "./modules/catalog/subcategory.routes";
import type { StoreService } from "./modules/stores/store.service";
import { storeRoutes } from "./modules/stores/store.routes";
import type { StoreCategoryService } from "./modules/catalog/store-category.service";
import { storeCategoryRoutes } from "./modules/catalog/store-category.routes";
import type { ProductService } from "./modules/catalog/product.service";
import { productRoutes } from "./modules/catalog/product.routes";
import type { ModifierService } from "./modules/catalog/modifier.service";
import { modifierRoutes } from "./modules/catalog/modifier.routes";
import { merchantCatalogRoutes } from "./modules/catalog/merchant-catalog.routes";
import type { CartService } from "./modules/cart/cart.service";
import { cartRoutes } from "./modules/cart/cart.routes";
import type { CustomerAddressService } from "./modules/customer-addresses/customer-address.service";
import { customerAddressRoutes } from "./modules/customer-addresses/customer-address.routes";
import type { DeliveryPricingService } from "./modules/delivery-pricing/delivery-pricing.service";
import { deliveryPricingRoutes } from "./modules/delivery-pricing/delivery-pricing.routes";

export interface AppDependencies extends HealthDependencies {
  logger: Logger;
  production: boolean;
  authModule?: AuthModule;
  geographyService?: GeographyService;
  mediaService?: MediaService;
  mainCategoryService?: MainCategoryService;
  subcategoryService?: SubcategoryService;
  storeService?: StoreService;
  storeCategoryService?: StoreCategoryService;
  productService?: ProductService;
  modifierService?: ModifierService;
  cartService?: CartService;
  customerAddressService?: CustomerAddressService;
  deliveryPricingService?: DeliveryPricingService;
}

export function createApp(dependencies: AppDependencies) {
  return new Elysia({ name: "pip-pip-api-v3" })
    .use(createOpenApiPlugin())
    .derive(({ request, set }) => {
      const requestId = resolveRequestId(request.headers.get("x-request-id"));
      set.headers["x-request-id"] = requestId;
      return {
        requestId,
        requestPath: new URL(request.url).pathname,
        requestStartedAt: performance.now(),
      };
    })
    .onAfterResponse(
      ({ request, set, requestId, requestPath, requestStartedAt }) => {
        dependencies.logger.info({
          event: "http_request_completed",
          method: request.method,
          path: requestPath,
          status: typeof set.status === "number" ? set.status : 200,
          request_id: requestId,
          duration_ms:
            Math.round((performance.now() - requestStartedAt) * 100) / 100,
        });
      },
    )
    .onError(({ error, code, request, requestId, set }) => {
      const path = new URL(request.url, "http://localhost").pathname;
      if (error instanceof AppError) {
        if (error.retryAfterSeconds)
          set.headers["retry-after"] = String(error.retryAfterSeconds);
        dependencies.logger.warn({
          event: "request_error",
          code: error.publicCode,
          path,
          request_id: requestId,
        });
        return status(error.statusCode, {
          error: { code: error.publicCode, message: error.message },
          request_id: requestId,
        });
      }
      if (code === "NOT_FOUND") {
        return status(404, {
          error: { code: "NOT_FOUND", message: "Resource not found" },
          request_id: requestId,
        });
      }
      if (code === "VALIDATION") {
        return status(422, {
          error: {
            code: "VALIDATION_FAILED",
            message: "The request is invalid",
          },
          request_id: requestId,
        });
      }
      if (code === "PARSE") {
        return status(422, {
          error: {
            code: "VALIDATION_FAILED",
            message: "The request is invalid",
          },
          request_id: requestId,
        });
      }
      dependencies.logger.error({
        event: "unexpected_error",
        path,
        request_id: requestId,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      return status(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred",
        },
        request_id: requestId,
      });
    })
    .use(healthRoutes(dependencies))
    .use(dependencies.authModule && dependencies.deliveryPricingService ? deliveryPricingRoutes(dependencies.authModule, dependencies.deliveryPricingService) : new Elysia())
    .use(
      dependencies.authModule && dependencies.cartService
        ? cartRoutes(dependencies.authModule, dependencies.cartService)
        : new Elysia(),
    )
    .use(
      dependencies.authModule && dependencies.customerAddressService
        ? customerAddressRoutes(
            dependencies.authModule,
            dependencies.customerAddressService,
          )
        : new Elysia(),
    )
    .use(
      dependencies.authModule
        ? authRoutes(dependencies.authModule)
        : new Elysia(),
    )
    .use(
      dependencies.authModule && dependencies.geographyService
        ? geographyRoutes(
            dependencies.authModule,
            dependencies.geographyService,
          )
        : new Elysia(),
    )
    .use(
      dependencies.authModule && dependencies.mediaService
        ? mediaRoutes(dependencies.authModule, dependencies.mediaService)
        : new Elysia(),
    )
    .use(
      dependencies.authModule && dependencies.mainCategoryService
        ? mainCategoryRoutes(
            dependencies.authModule,
            dependencies.mainCategoryService,
          )
        : new Elysia(),
    )
    .use(
      dependencies.authModule && dependencies.subcategoryService
        ? subcategoryRoutes(
            dependencies.authModule,
            dependencies.subcategoryService,
          )
        : new Elysia(),
    )
    .use(
      dependencies.authModule && dependencies.storeService
        ? storeRoutes(dependencies.authModule, dependencies.storeService)
        : new Elysia(),
    )
    .use(
      dependencies.authModule && dependencies.storeCategoryService
        ? storeCategoryRoutes(
            dependencies.authModule,
            dependencies.storeCategoryService,
          )
        : new Elysia(),
    )
    .use(
      dependencies.authModule && dependencies.productService
        ? productRoutes(
            dependencies.authModule,
            dependencies.productService,
            dependencies.modifierService,
          )
        : new Elysia(),
    )
    .use(
      dependencies.authModule && dependencies.modifierService
        ? modifierRoutes(dependencies.authModule, dependencies.modifierService)
        : new Elysia(),
    )
    .use(
      dependencies.authModule &&
        dependencies.productService &&
        dependencies.storeCategoryService &&
        dependencies.modifierService &&
        dependencies.storeService &&
        dependencies.mediaService
        ? merchantCatalogRoutes(dependencies.authModule, {
            products: dependencies.productService,
            storeCategories: dependencies.storeCategoryService,
            modifiers: dependencies.modifierService,
            stores: dependencies.storeService,
            media: dependencies.mediaService,
          })
        : new Elysia(),
    );
}
