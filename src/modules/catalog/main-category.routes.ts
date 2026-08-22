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
import type { MainCategoryService } from "./main-category.service";

const categoryStatus = t.Union([
  t.Literal("ACTIVE"),
  t.Literal("INACTIVE"),
  t.Literal("ARCHIVED"),
]);

const imageDto = t.Object({
  assetId: t.String({ format: "uuid" }),
  url: t.Nullable(t.String()),
});

const mainCategoryDto = t.Object({
  id: t.String({ format: "uuid" }),
  cityId: t.String({ format: "uuid" }),
  name: t.String(),
  status: categoryStatus,
  displayOrder: t.Integer({ minimum: 0 }),
  image: imageDto,
  createdAt: dateSchema,
  updatedAt: dateSchema,
  archivedAt: t.Nullable(dateSchema),
  createdByAccountId: t.String({ format: "uuid" }),
  updatedByAccountId: t.Nullable(t.String({ format: "uuid" })),
  archivedByAccountId: t.Nullable(t.String({ format: "uuid" })),
  translations: t.Array(t.Object({ locale: t.String(), name: t.String() })),
});

const publicMainCategoryDto = t.Object({
  id: t.String({ format: "uuid" }),
  name: t.String(),
  resolvedLocale: t.String(),
  displayOrder: t.Integer({ minimum: 0 }),
  image: imageDto,
});

const listResponse = dashboardPaginated(mainCategoryDto);
const publicListResponse = t.Object({ data: t.Array(publicMainCategoryDto) });

const mainCategoryIdParam = t.Object(
  { mainCategoryId: t.String({ format: "uuid" }) },
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
  "cityId",
  "translations",
  "imageAssetId",
  "status",
  "displayOrder",
]);
const patchBodyKeys = new Set([
  "translations",
  "imageAssetId",
  "status",
  "displayOrder",
]);

const parseMainCategoryBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  if (method === "POST" && path.endsWith("/dashboard/main-categories")) {
    assertAllowedBodyKeys(body, createBodyKeys);
  }
  if (
    method === "PATCH" &&
    /\/dashboard\/main-categories\/[^/]+$/.test(path)
  ) {
    assertAllowedBodyKeys(body, patchBodyKeys);
  }
  return body;
};

const cityIdHeaderParam = {
  $ref: "#/components/parameters/CityIdHeader",
};

export const mainCategoryRoutes = (
  auth: AuthModule,
  service: MainCategoryService,
) =>
  new Elysia({ name: "main-category-routes" })
    .onParse(parseMainCategoryBody)
    .post(
      "/api/v1/dashboard/main-categories",
      async ({ request, set, body }) =>
        service.create(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          (body as { cityId: string }).cityId,
          (() => { const { cityId: _cityId, ...input } = body as Record<string, unknown>; return input; })(),
          requestIdOf(set),
        ),
      {
        parse: "json",
        body: t.Object(
          {
            cityId: t.String({ format: "uuid" }),
            translations: t.Array(t.Object({ locale: t.String({ minLength: 2, maxLength: 35 }), name: t.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }), { minItems: 1 }),
            imageAssetId: t.String({ format: "uuid" }),
            status: t.Optional(
              t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")]),
            ),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: mainCategoryDto, ...createErrors },
        detail: {
          tags: ["Dashboard — Main Categories"],
          summary: "Create a Main Category in an explicitly targeted City",
          description:
            "SUPER_ADMIN only. cityId is required in the body. Requires a READY PUBLIC CATEGORY_IMAGE media asset and claims it in the same transaction as the insert.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/main-categories",
      async ({ request, set, query }) =>
        service.list(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          query,
        ),
      {
        query: t.Object(
          {
            cityId: t.String({ format: "uuid" }), ...dashboardListQuery,
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
          tags: ["Dashboard — Main Categories"],
          summary: "List Main Categories for an explicitly targeted City",
          description:
            "SUPER_ADMIN only. cityId is required in query. Defaults to excluding ARCHIVED unless status=ARCHIVED is requested.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/main-categories/:mainCategoryId",
      async ({ request, set, params, query }) =>
        service.get(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.mainCategoryId,
          query.cityId,
        ),
      {
        params: mainCategoryIdParam,
        query: t.Object({ cityId: t.String({ format: "uuid" }) }, { additionalProperties: false }),
        response: { 200: mainCategoryDto, ...detailErrors },
        detail: {
          tags: ["Dashboard — Main Categories"],
          summary: "Get a Main Category in an explicitly targeted City",
          description: "SUPER_ADMIN only. cityId is required in query; reassignment is not supported.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/main-categories/:mainCategoryId",
      async ({ request, set, params, body, query }) =>
        service.update(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.mainCategoryId,
          body,
          requestIdOf(set),
          query.cityId,
        ),
      {
        params: mainCategoryIdParam,
        query: t.Object({ cityId: t.String({ format: "uuid" }) }, { additionalProperties: false }),
        parse: "json",
        body: t.Object(
          {
            translations: t.Optional(t.Array(t.Object({ locale: t.String({ minLength: 2, maxLength: 35 }), name: t.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }), { minItems: 1 })),
            imageAssetId: t.Optional(t.String({ format: "uuid" })),
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
        response: { 200: mainCategoryDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Main Categories"],
          summary: "Update a Main Category in an explicitly targeted City",
          description:
            "SUPER_ADMIN only. cityId is required in query. Image replacement claims the new asset and releases the old asset in one transaction. ARCHIVED status is rejected — use DELETE to archive.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .delete(
      "/api/v1/dashboard/main-categories/:mainCategoryId",
      async ({ request, set, params, query }) =>
        service.archive(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.mainCategoryId,
          requestIdOf(set),
          query.cityId,
        ),
      {
        params: mainCategoryIdParam,
        query: t.Object({ cityId: t.String({ format: "uuid" }) }, { additionalProperties: false }),
        response: { 200: mainCategoryDto, ...mutationErrors },
        detail: {
          tags: ["Dashboard — Main Categories"],
          summary: "Soft-archive a Main Category in an explicitly targeted City",
          description:
            "SUPER_ADMIN only. cityId is required in query. Soft archive only. Idempotent when already ARCHIVED. Keeps the final image asset claimed and referenced.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/public/main-categories",
      async ({ request }) => {
        const city = await requirePublicCityContext(auth.client, request);
        return service.listPublic(city.city.id, request);
      },
      {
        query: t.Object({}, { additionalProperties: false }),
        headers: t.Object(
          { "x-city-id": t.Optional(t.String({ maxLength: 128 })) },
          { additionalProperties: true },
        ),
        response: { 200: publicListResponse, ...publicErrors },
        detail: {
          tags: ["Public — Main Categories"],
          summary: "List active Main Categories for the City selected by X-City-Id",
          description:
            "Returns ACTIVE, non-archived Main Categories with READY PUBLIC images only. " +
            "cityId query/path parameters are not accepted.",
          parameters: [cityIdHeaderParam],
        },
      },
    );
