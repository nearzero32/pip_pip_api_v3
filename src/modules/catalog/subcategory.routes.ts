import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import { dashboardContext } from "../auth/core/context";
import { requirePublicCityContext } from "../auth/city/public-city-context";
import {
  errorResponse,
  parseAuthenticationBody,
  standardErrors,
} from "../auth/http/shared";
import {
  assertAllowedBodyKeys,
  authIdentity,
  dashboardDetailErrors,
  dashboardListErrors,
  dashboardMutationErrors,
  dateSchema,
  requestIdOf,
} from "../geography/shared";
import {
  dashboardListQuery,
  dashboardPaginated,
} from "../dashboard-lists/query";
import type { SubcategoryService } from "./subcategory.service";
import { AppError } from "../../errors/app-error";

const categoryStatus = t.Union([
  t.Literal("ACTIVE"),
  t.Literal("INACTIVE"),
  t.Literal("ARCHIVED"),
]);

const imageDto = t.Object({
  assetId: t.String({ format: "uuid" }),
  url: t.Nullable(t.String()),
});

const subcategoryDto = t.Object({
  id: t.String({ format: "uuid" }),
  mainCategory: t.Object({
    id: t.String({ format: "uuid" }),
    name: t.String(),
  }),
  name: t.String(),
  status: categoryStatus,
  displayOrder: t.Integer({ minimum: 0 }),
  image: t.Nullable(imageDto),
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
  translations: t.Array(t.Object({ locale: t.String(), name: t.String() })),
});

const publicSubcategoryDto = t.Object({
  id: t.String({ format: "uuid" }),
  name: t.String(),
  resolvedLocale: t.String(),
  displayOrder: t.Integer({ minimum: 0 }),
  image: t.Nullable(imageDto),
});

const listResponse = dashboardPaginated(subcategoryDto);
const publicListResponse = t.Object({ data: t.Array(publicSubcategoryDto) });

const subcategoryIdParam = t.Object(
  { subcategoryId: t.String({ format: "uuid" }) },
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
const publicErrors = {
  400: errorResponse,
  404: errorResponse,
  409: errorResponse,
  422: errorResponse,
  500: errorResponse,
};

const createBodyKeys = new Set([
  "mainCategoryId",
  "translations",
  "imageAssetId",
  "status",
  "displayOrder",
]);
const patchBodyKeys = new Set([
  "mainCategoryId",
  "translations",
  "imageAssetId",
  "status",
  "displayOrder",
]);

const parseSubcategoryBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  if (method === "POST" && path.endsWith("/dashboard/subcategories")) {
    assertAllowedBodyKeys(body, createBodyKeys);
  }
  if (method === "PATCH" && /\/dashboard\/subcategories\/[^/]+$/.test(path)) {
    assertAllowedBodyKeys(body, patchBodyKeys);
  }
  return body;
};

const cityIdHeaderParam = {
  $ref: "#/components/parameters/CityIdHeader",
};

const superAdminTargetCity = (request: Request) => {
  const cityId = new URL(request.url).searchParams.get("cityId");
  if (!cityId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cityId)) {
    throw new AppError(422, "VALIDATION_FAILED", "cityId must be a UUID");
  }
  return cityId;
};

const superAdminSubcategoryListQuery = t.Object(
  {
    cityId: t.String({ format: "uuid" }),
    ...dashboardListQuery,
    mainCategoryId: t.Optional(t.String({ format: "uuid" })),
    status: t.Optional(categoryStatus),
  },
  { additionalProperties: false },
);

export const subcategoryRoutes = (
  auth: AuthModule,
  service: SubcategoryService,
) =>
  new Elysia({ name: "subcategory-routes" })
    .onParse(parseSubcategoryBody)
    .post("/api/v1/super-admin/subcategories", async ({ request, set, body }) => {
      const input = body as Record<string, unknown>;
      const cityId = typeof input.cityId === "string" ? input.cityId : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cityId)) throw new AppError(422, "VALIDATION_FAILED", "cityId must be a UUID");
      const { cityId: _cityId, ...payload } = input;
      return service.create(await authIdentity(auth, request, dashboardContext, requestIdOf(set)), payload, requestIdOf(set), cityId);
    })
    .get("/api/v1/super-admin/subcategories", async ({ request, set, query }) => service.list(await authIdentity(auth, request, dashboardContext, requestIdOf(set)), query, superAdminTargetCity(request)), { query: superAdminSubcategoryListQuery })
    .get("/api/v1/super-admin/subcategories/:subcategoryId", async ({ request, set, params }) => service.get(await authIdentity(auth, request, dashboardContext, requestIdOf(set)), params.subcategoryId, superAdminTargetCity(request)))
    .patch("/api/v1/super-admin/subcategories/:subcategoryId", async ({ request, set, params, body }) => service.update(await authIdentity(auth, request, dashboardContext, requestIdOf(set)), params.subcategoryId, body, requestIdOf(set), superAdminTargetCity(request)))
    .delete("/api/v1/super-admin/subcategories/:subcategoryId", async ({ request, set, params }) => service.archive(await authIdentity(auth, request, dashboardContext, requestIdOf(set)), params.subcategoryId, requestIdOf(set), superAdminTargetCity(request)))
    .post(
      "/api/v1/dashboard/subcategories",
      async ({ request, set, body }) =>
        service.create(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          body,
          requestIdOf(set),
        ),
      {
        parse: "json",
        body: t.Object(
          {
            mainCategoryId: t.String({ format: "uuid" }),
            translations: t.Array(t.Object({ locale: t.String({ minLength: 2, maxLength: 35 }), name: t.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }), { minItems: 1 }),
            imageAssetId: t.Optional(t.String({ format: "uuid" })),
            status: t.Optional(
              t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")]),
            ),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: subcategoryDto, ...createErrors },
        detail: {
          tags: ["Dashboard — Subcategories"],
          summary: "Create a Subcategory under a Main Category",
          description:
            "Image is optional. When supplied it must be a READY PUBLIC CATEGORY_IMAGE. Parent must be non-archived in the signed City.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/subcategories",
      async ({ request, set, query }) =>
        service.list(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          query,
        ),
      {
        query: t.Object(
          {
            ...dashboardListQuery,
            mainCategoryId: t.Optional(t.String({ format: "uuid" })),
            status: t.Optional(
              t.Union([
                t.Literal("ACTIVE"),
                t.Literal("INACTIVE"),
                t.Literal("ARCHIVED"),
              ]),
            ),
          },
          { additionalProperties: false },
        ),
        response: { 200: listResponse, ...listErrors },
        detail: {
          tags: ["Dashboard — Subcategories"],
          summary: "List Subcategories for the authenticated City",
          description:
            "Defaults to excluding ARCHIVED unless status is set. Optional mainCategoryId is City-scoped.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/subcategories/:subcategoryId",
      async ({ request, set, params }) =>
        service.get(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.subcategoryId,
        ),
      {
        params: subcategoryIdParam,
        response: { 200: subcategoryDto, ...detailErrors },
        detail: {
          tags: ["Dashboard — Subcategories"],
          summary: "Get a Subcategory in the authenticated City",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/subcategories/:subcategoryId",
      async ({ request, set, params, body }) =>
        service.update(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.subcategoryId,
          body,
          requestIdOf(set),
        ),
      {
        params: subcategoryIdParam,
        parse: "json",
        body: t.Object(
          {
            mainCategoryId: t.Optional(t.String({ format: "uuid" })),
            translations: t.Optional(t.Array(t.Object({ locale: t.String({ minLength: 2, maxLength: 35 }), name: t.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }), { minItems: 1 })),
            imageAssetId: t.Optional(
              t.Union([t.String({ format: "uuid" }), t.Null()]),
            ),
            status: t.Optional(
              t.Union([
                t.Literal("ACTIVE"),
                t.Literal("INACTIVE"),
                t.Literal("ARCHIVED"),
              ]),
            ),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: subcategoryDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Subcategories"],
          summary: "Update or move a Subcategory in the authenticated City",
          description:
            "imageAssetId omitted keeps the image; UUID attaches/replaces; null removes. ARCHIVED status is rejected — use DELETE. Movement requires a non-archived same-City parent.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .delete(
      "/api/v1/dashboard/subcategories/:subcategoryId",
      async ({ request, set, params }) =>
        service.archive(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.subcategoryId,
          requestIdOf(set),
        ),
      {
        params: subcategoryIdParam,
        response: { 200: subcategoryDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Subcategories"],
          summary: "Soft-archive a Subcategory in the authenticated City",
          description:
            "Soft archive only. Idempotent when already ARCHIVED. Clears image_asset_id and releases any optional image in the same transaction.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/public/subcategories",
      async ({ request, query }) => {
        const city = await requirePublicCityContext(auth.client, request);
        return service.listPublic(city.city.id, query.mainCategoryId, request);
      },
      {
        query: t.Object(
          {
            mainCategoryId: t.String({ format: "uuid" }),
            lang: t.Optional(t.String({ minLength: 2, maxLength: 35 })),
          },
          { additionalProperties: false },
        ),
        headers: t.Object(
          { "x-city-id": t.Optional(t.String({ maxLength: 128 })) },
          { additionalProperties: true },
        ),
        response: { 200: publicListResponse, ...publicErrors },
        detail: {
          tags: ["Public — Subcategories"],
          summary:
            "List active Subcategories for a Main Category in the City selected by X-City-Id",
          description:
            "Requires mainCategoryId. Returns ACTIVE non-archived Subcategories only when the parent Main Category is ACTIVE and non-archived in the header City.",
          parameters: [cityIdHeaderParam],
        },
      },
    );
