import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import { dashboardContext } from "../auth/core/context";
import {
  errorResponse,
  parseAuthenticationBody,
  standardErrors,
} from "../auth/http/shared";
import { requirePublicCityContext } from "../auth/city/public-city-context";
import {
  assertAllowedBodyKeys,
  authIdentity,
  dashboardDetailErrors,
  dashboardListErrors,
  dashboardMutationErrors,
  dateSchema,
  pageQuery,
  paginated,
  requestIdOf,
} from "../geography/shared";
import {
  dashboardListQuery,
  dashboardPaginated,
} from "../dashboard-lists/query";
import { document } from "../../openapi/document";
import { catalogExamples } from "../../openapi/examples/catalog";
import type { ModifierService } from "./modifier.service";
import type { ProductService } from "./product.service";

const productStatus = t.Union([
  t.Literal("ACTIVE"),
  t.Literal("INACTIVE"),
  t.Literal("ARCHIVED"),
]);

const mutableStatus = t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")]);

const weekday = t.Union([
  t.Literal("MONDAY"),
  t.Literal("TUESDAY"),
  t.Literal("WEDNESDAY"),
  t.Literal("THURSDAY"),
  t.Literal("FRIDAY"),
  t.Literal("SATURDAY"),
  t.Literal("SUNDAY"),
]);

const imageDto = t.Object({
  id: t.String({ format: "uuid" }),
  assetId: t.String({ format: "uuid" }),
  url: t.Nullable(t.String()),
  isPrimary: t.Boolean(),
  displayOrder: t.Integer({ minimum: 0 }),
});

const sizeDto = t.Object({
  id: t.String({ format: "uuid" }),
  name: t.String(),
  price: t.Integer({ exclusiveMinimum: 0 }),
  status: productStatus,
  isAvailable: t.Boolean(),
  isDefault: t.Boolean(),
  displayOrder: t.Integer({ minimum: 0 }),
  archivedAt: t.Nullable(dateSchema),
  translations: t.Array(t.Object({ locale: t.String(), name: t.String() })),
});

const availabilityDto = t.Object({
  id: t.String({ format: "uuid" }),
  dayOfWeek: weekday,
  opensAt: t.String(),
  closesAt: t.String(),
});

const productDto = t.Object({
  id: t.String({ format: "uuid" }),
  storeId: t.String({ format: "uuid" }),
  categoryId: t.Nullable(t.String({ format: "uuid" })),
  modifierGroupId: t.Nullable(t.String({ format: "uuid" })),
  name: t.String(),
  description: t.Nullable(t.String()),
  translations: t.Array(t.Object({ locale: t.String(), name: t.String(), description: t.Optional(t.Nullable(t.String())) })),
  basePrice: t.Nullable(t.Integer({ exclusiveMinimum: 0 })),
  status: productStatus,
  isAvailable: t.Boolean(),
  displayOrder: t.Integer({ minimum: 0 }),
  images: t.Array(imageDto),
  sizes: t.Array(sizeDto),
  availability: t.Array(availabilityDto),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
});

const listResponse = dashboardPaginated(productDto);

const storeIdParam = t.Object(
  { storeId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);

const productParams = t.Object(
  {
    storeId: t.String({ format: "uuid" }),
    productId: t.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

const sizeParams = t.Object(
  {
    storeId: t.String({ format: "uuid" }),
    productId: t.String({ format: "uuid" }),
    sizeId: t.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

const imageInput = t.Object(
  {
    assetId: t.String({ format: "uuid" }),
    isPrimary: t.Boolean(),
    displayOrder: t.Optional(t.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const sizeInput = t.Object(
  {
    translations: t.Array(t.Object({ locale: t.String({ minLength: 2, maxLength: 35 }), name: t.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }), { minItems: 1 }),
    price: t.Integer({ exclusiveMinimum: 0 }),
    isDefault: t.Boolean(),
    isAvailable: t.Optional(t.Boolean()),
    status: t.Optional(mutableStatus),
    displayOrder: t.Optional(t.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const availabilityInput = t.Object(
  {
    dayOfWeek: weekday,
    opensAt: t.String(),
    closesAt: t.String(),
  },
  { additionalProperties: false },
);

const createErrors = {
  ...standardErrors,
  400: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};
const listErrors = {
  ...dashboardListErrors,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};
const detailErrors = {
  ...dashboardDetailErrors,
  403: errorResponse,
  409: errorResponse,
};
const mutationErrors = {
  ...dashboardMutationErrors,
  400: errorResponse,
  409: errorResponse,
};

const createBodyKeys = new Set([
  "translations",
  "categoryId",
  "modifierGroupId",
  "basePrice",
  "status",
  "isAvailable",
  "displayOrder",
  "images",
  "sizes",
  "availability",
]);
const patchBodyKeys = new Set([
  "translations",
  "categoryId",
  "modifierGroupId",
  "basePrice",
  "status",
  "isAvailable",
  "displayOrder",
]);
const imagesBodyKeys = new Set(["images"]);
const addSizeBodyKeys = new Set([
  "translations",
  "price",
  "isDefault",
  "isAvailable",
  "status",
  "displayOrder",
  "transitionFromBasePrice",
]);
const patchSizeBodyKeys = new Set([
  "translations",
  "price",
  "isDefault",
  "isAvailable",
  "status",
  "displayOrder",
  "replacementDefaultSizeId",
]);
const archiveSizeBodyKeys = new Set([
  "replacementDefaultSizeId",
  "basePrice",
]);
const availabilityBodyKeys = new Set(["windows"]);

const parseProductBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  if (
    method === "POST" &&
    /\/dashboard\/stores\/[^/]+\/products$/.test(path)
  ) {
    assertAllowedBodyKeys(body, createBodyKeys);
  }
  if (
    method === "PATCH" &&
    /\/dashboard\/stores\/[^/]+\/products\/[^/]+$/.test(path)
  ) {
    assertAllowedBodyKeys(body, patchBodyKeys);
  }
  if (
    method === "PUT" &&
    /\/dashboard\/stores\/[^/]+\/products\/[^/]+\/images$/.test(path)
  ) {
    assertAllowedBodyKeys(body, imagesBodyKeys);
  }
  if (
    method === "POST" &&
    /\/dashboard\/stores\/[^/]+\/products\/[^/]+\/sizes$/.test(path)
  ) {
    assertAllowedBodyKeys(body, addSizeBodyKeys);
  }
  if (
    method === "PATCH" &&
    /\/dashboard\/stores\/[^/]+\/products\/[^/]+\/sizes\/[^/]+$/.test(path)
  ) {
    assertAllowedBodyKeys(body, patchSizeBodyKeys);
  }
  if (
    method === "DELETE" &&
    /\/dashboard\/stores\/[^/]+\/products\/[^/]+\/sizes\/[^/]+$/.test(path)
  ) {
    assertAllowedBodyKeys(body, archiveSizeBodyKeys);
  }
  if (
    method === "PUT" &&
    /\/dashboard\/stores\/[^/]+\/products\/[^/]+\/availability$/.test(path)
  ) {
    assertAllowedBodyKeys(body, availabilityBodyKeys);
  }
  return body;
};

export const productRoutes = (
  auth: AuthModule,
  service: ProductService,
  modifiers?: ModifierService,
) =>
  new Elysia({ name: "product-routes" })
    .onParse(parseProductBody)
    .post(
      "/api/v1/dashboard/stores/:storeId/products",
      async ({ request, set, params, body }) =>
        service.create(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          body,
          requestIdOf(set),
        ),
      {
        params: storeIdParam,
        parse: "json",
        body: document(
          t.Object(
          {
            translations: t.Array(t.Object({ locale: t.String({ minLength: 2, maxLength: 35 }), name: t.String({ minLength: 1, maxLength: 100 }), description: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])) }, { additionalProperties: false }), { minItems: 1 }),
            categoryId: t.Optional(
              t.Union([t.String({ format: "uuid" }), t.Null()]),
            ),
            modifierGroupId: t.Optional(
              t.Union([t.String({ format: "uuid" }), t.Null()]),
            ),
            basePrice: t.Optional(
              t.Union([t.Integer({ exclusiveMinimum: 0 }), t.Null()]),
            ),
            status: t.Optional(mutableStatus),
            isAvailable: t.Optional(t.Boolean()),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
            images: t.Array(imageInput, { minItems: 1 }),
            sizes: t.Optional(t.Array(sizeInput)),
            availability: t.Optional(t.Array(availabilityInput)),
          },
          { additionalProperties: false },
        ),
          catalogExamples.productBasePrice,
          {
            "Base-price product": {
              summary: "Positive basePrice and no sizes",
              value: catalogExamples.productBasePrice,
            },
            "Sized product": {
              summary: "Null basePrice with sizes",
              value: catalogExamples.productSized,
            },
          },
        ),
        response: { 200: productDto, ...createErrors },
        detail: {
          tags: ["Dashboard — Products"],
          summary: "Create a Store product",
          description:
            "Atomic create with 1–10 images (exactly one primary), optional sizes, and optional weekly availability. Pricing invariant: either positive basePrice with no sizes, or null basePrice with ≥1 size and exactly one ACTIVE default. Optional modifierGroupId assigns a Group without auto-enabling Options. Do not send cityId or storeId in the body.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/stores/:storeId/products",
      async ({ request, set, params, query }) =>
        service.list(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          query,
        ),
      {
        params: storeIdParam,
        query: t.Object(
          {
            ...dashboardListQuery,
            status: t.Optional(productStatus),
            categoryId: t.Optional(t.String({ maxLength: 64 })),
            isAvailable: t.Optional(t.String()),
            hasSizes: t.Optional(t.String()),
            modifierGroupId: t.Optional(t.String({ format: "uuid" })),
            createdFrom: t.Optional(t.String({ examples: ["2026-08-01"] })),
            createdTo: t.Optional(t.String({ examples: ["2026-08-16"] })),
          },
          { additionalProperties: false },
        ),
        response: { 200: listResponse, ...listErrors },
        detail: {
          tags: ["Dashboard — Products"],
          summary: "List Store products",
          description:
            "Defaults to excluding ARCHIVED. Optional status, categoryId (use literal `null` for uncategorized), and search. Paginated. Images, sizes, and availability are batch-loaded.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/stores/:storeId/products/:productId",
      async ({ request, set, params }) =>
        service.get(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.productId,
        ),
      {
        params: productParams,
        response: { 200: productDto, ...detailErrors },
        detail: {
          tags: ["Dashboard — Products"],
          summary: "Get a Store product",
          description:
            "Cross-City Store or Product identifiers return not-found without leaking foreign City data.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/stores/:storeId/products/:productId",
      async ({ request, set, params, body }) =>
        service.update(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.productId,
          body,
          requestIdOf(set),
        ),
      {
        params: productParams,
        parse: "json",
        body: t.Object(
          {
            translations: t.Optional(t.Array(t.Object({ locale: t.String({ minLength: 2, maxLength: 35 }), name: t.String({ minLength: 1, maxLength: 100 }), description: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])) }, { additionalProperties: false }), { minItems: 1 })),
            categoryId: t.Optional(
              t.Union([t.String({ format: "uuid" }), t.Null()]),
            ),
            modifierGroupId: t.Optional(
              t.Union([t.String({ format: "uuid" }), t.Null()]),
            ),
            basePrice: t.Optional(
              t.Union([t.Integer({ exclusiveMinimum: 0 }), t.Null()]),
            ),
            status: t.Optional(mutableStatus),
            isAvailable: t.Optional(t.Boolean()),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: productDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Products"],
          summary: "Update a Store product",
          description:
            "Omitted fields unchanged. categoryId/modifierGroupId null clears those relations. Changing modifierGroupId preserves old ProductModifierOption rows and does not auto-activate Options from the new Group. status ARCHIVED is rejected — use DELETE.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .delete(
      "/api/v1/dashboard/stores/:storeId/products/:productId",
      async ({ request, set, params }) =>
        service.archive(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.productId,
          requestIdOf(set),
        ),
      {
        params: productParams,
        response: { 200: productDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Products"],
          summary: "Soft-archive a Store product",
          description:
            "Sets status=ARCHIVED and archived_at. Does not release images or archive sizes/availability rows. Idempotent when already ARCHIVED.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .put(
      "/api/v1/dashboard/stores/:storeId/products/:productId/images",
      async ({ request, set, params, body }) =>
        service.replaceImages(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.productId,
          (body as { images: unknown }).images,
          requestIdOf(set),
        ),
      {
        params: productParams,
        parse: "json",
        body: t.Object(
          {
            images: t.Array(imageInput, { minItems: 1 }),
          },
          { additionalProperties: false },
        ),
        response: { 200: productDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Products"],
          summary: "Replace product images",
          description:
            "Full replace of 1–10 PRODUCT_IMAGE assets with exactly one primary. New assets are claimed; removed assets are released.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .post(
      "/api/v1/dashboard/stores/:storeId/products/:productId/sizes",
      async ({ request, set, params, body }) =>
        service.addSize(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.productId,
          body,
          requestIdOf(set),
        ),
      {
        params: productParams,
        parse: "json",
        body: t.Object(
          {
            translations: t.Array(t.Object({ locale: t.String({ minLength: 2, maxLength: 35 }), name: t.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }), { minItems: 1 }),
            price: t.Integer({ exclusiveMinimum: 0 }),
            isDefault: t.Boolean(),
            isAvailable: t.Optional(t.Boolean()),
            status: t.Optional(mutableStatus),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
            transitionFromBasePrice: t.Optional(t.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: { 200: productDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Products"],
          summary: "Add a product size",
          description:
            "When the product currently has basePrice and no sizes, transitionFromBasePrice=true is required and clears basePrice atomically. Exactly one ACTIVE default must remain.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/stores/:storeId/products/:productId/sizes/:sizeId",
      async ({ request, set, params, body }) =>
        service.updateSize(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.productId,
          params.sizeId,
          body,
          requestIdOf(set),
        ),
      {
        params: sizeParams,
        parse: "json",
        body: t.Object(
          {
            translations: t.Optional(t.Array(t.Object({ locale: t.String({ minLength: 2, maxLength: 35 }), name: t.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }), { minItems: 1 })),
            price: t.Optional(t.Integer({ exclusiveMinimum: 0 })),
            isDefault: t.Optional(t.Boolean()),
            isAvailable: t.Optional(t.Boolean()),
            status: t.Optional(mutableStatus),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
            replacementDefaultSizeId: t.Optional(t.String({ format: "uuid" })),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: productDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Products"],
          summary: "Update a product size",
          description:
            "Clearing or deactivating the current default requires replacementDefaultSizeId of another ACTIVE size.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .delete(
      "/api/v1/dashboard/stores/:storeId/products/:productId/sizes/:sizeId",
      async ({ request, set, params, body }) =>
        service.archiveSize(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.productId,
          params.sizeId,
          body,
          requestIdOf(set),
        ),
      {
        params: sizeParams,
        parse: "json",
        body: t.Optional(
          t.Object(
            {
              replacementDefaultSizeId: t.Optional(
                t.String({ format: "uuid" }),
              ),
              basePrice: t.Optional(t.Integer({ exclusiveMinimum: 0 })),
            },
            { additionalProperties: false },
          ),
        ),
        response: { 200: productDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Products"],
          summary: "Soft-archive a product size",
          description:
            "Archiving the last non-archived size requires basePrice to restore product base pricing. Archiving the default requires replacementDefaultSizeId.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .put(
      "/api/v1/dashboard/stores/:storeId/products/:productId/availability",
      async ({ request, set, params, body }) =>
        service.replaceAvailability(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          params.productId,
          (body as { windows: unknown }).windows,
          requestIdOf(set),
        ),
      {
        params: productParams,
        parse: "json",
        body: t.Object(
          {
            windows: t.Array(availabilityInput),
          },
          { additionalProperties: false },
        ),
        response: { 200: productDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Products"],
          summary: "Replace product availability windows",
          description:
            "Full replace of recurring weekly windows (Asia/Baghdad wall-clock). Same-day only; overlaps rejected.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/public/stores/:storeId/products",
      async ({ request, params, query }) => {
        const { city } = await requirePublicCityContext(auth.client, request);
        return service.listPublic(city.id, params.storeId, query, request);
      },
      {
        params: storeIdParam,
        query: t.Object(
          {
            page: pageQuery.page,
            limit: pageQuery.limit,
            search: pageQuery.search,
            categoryId: t.Optional(t.String({ format: "uuid" })),
            lang: t.Optional(t.String({ minLength: 2, maxLength: 35 })),
          },
          { additionalProperties: false },
        ),
        response: {
          200: paginated(
            t.Object({
              id: t.String({ format: "uuid" }),
              storeId: t.String({ format: "uuid" }),
              categoryId: t.Nullable(t.String({ format: "uuid" })),
              name: t.String(),
              resolvedLocale: t.String(),
              basePrice: t.Nullable(t.Integer({ exclusiveMinimum: 0 })),
              price: t.Nullable(t.Integer({ exclusiveMinimum: 0 })),
              isAvailable: t.Boolean(),
              isOrderable: t.Boolean(),
              displayOrder: t.Integer({ minimum: 0 }),
              primaryImage: t.Nullable(
                t.Object({
                  id: t.String({ format: "uuid" }),
                  assetId: t.String({ format: "uuid" }),
                  url: t.Nullable(t.String()),
                  isPrimary: t.Boolean(),
                  displayOrder: t.Integer({ minimum: 0 }),
                }),
              ),
            }),
          ),
          400: errorResponse,
          404: errorResponse,
          409: errorResponse,
          ...standardErrors,
        },
        detail: {
          tags: ["Public — Products"],
          summary: "List public Store Products",
          description:
            "Requires X-City-Id. Paginated lightweight cards. ACTIVE Products only; INACTIVE/ARCHIVED categories hide their Products; isAvailable=false remains listed as non-orderable. Search is case-insensitive within the Store. PAUSED Stores remain browseable.",
          parameters: [
            {
              name: "X-City-Id",
              in: "header",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
        },
      },
    )
    .get(
      "/api/v1/public/stores/:storeId/products/:productId",
      async ({ request, params }) => {
        const { city } = await requirePublicCityContext(auth.client, request);
        const product = await service.getPublic(
          city.id,
          params.storeId,
          params.productId,
          request,
        );
        const mods = modifiers
          ? await modifiers.publicProductModifiers(
              request,
              params.storeId,
              params.productId,
            )
          : { productId: params.productId, group: null, options: [] };
        return {
          ...product,
          modifiers: {
            group: mods.group,
            options: mods.options,
          },
        };
      },
      {
        params: productParams,
        response: {
          200: t.Any(),
          400: errorResponse,
          404: errorResponse,
          409: errorResponse,
          ...standardErrors,
        },
        detail: {
          tags: ["Public — Products"],
          summary: "Get public Product Details",
          description:
            "Requires X-City-Id. Full Customer-facing Product configuration including images, sizes, availability windows, Store orderAcceptanceStatus, and current-group Modifier configuration. Temporarily unavailable Products remain readable with isOrderable=false. Cross-Store/City IDs return not-found.",
          parameters: [
            {
              name: "X-City-Id",
              in: "header",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
        },
      },
    );
