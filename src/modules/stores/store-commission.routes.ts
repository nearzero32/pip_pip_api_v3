import { Elysia, t } from "elysia";
import { AppError } from "../../errors/app-error";
import type { AuthModule } from "../auth/auth-module";
import { dashboardContext } from "../auth/core/context";
import {
  errorResponse,
  standardErrors,
} from "../auth/http/shared";
import {
  assertAllowedBodyKeys,
  authIdentity,
  dashboardDetailErrors,
  dashboardListErrors,
  dateSchema,
  pageQuery,
  paginated,
  requestIdOf,
} from "../geography/shared";
import type { StoreCommissionService } from "./store-commission.service";
import { document } from "../../openapi/document";
import { orderExamples } from "../../openapi/examples/orders";

const uuid = t.String({ format: "uuid" });
const errors = {
  ...standardErrors,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};
const commissionDto = t.Object({
  storeId: uuid,
  storeName: t.String(),
  status: t.String(),
  cityId: uuid,
  cityNameAr: t.String(),
  platformCommissionRate: t.Integer({ minimum: 0, maximum: 100 }),
  updatedAt: dateSchema,
  lastCommissionChangedAt: t.Nullable(dateSchema),
  lastChangedByAccountId: t.Nullable(uuid),
  lastChangedByEmail: t.Nullable(t.String()),
});
const historyDto = t.Object({
  id: uuid,
  storeId: uuid,
  storeName: t.String(),
  cityId: uuid,
  previousRate: t.Integer({ minimum: 0, maximum: 100 }),
  newRate: t.Integer({ minimum: 0, maximum: 100 }),
  reason: t.String(),
  note: t.Nullable(t.String()),
  changedByAccountId: uuid,
  changedByEmail: t.Nullable(t.String()),
  changedAt: dateSchema,
});
const patchKeys = new Set(["platformCommissionRate", "reason", "note"]);
const idempotencyKeyOf = (request: Request) => {
  const key = request.headers.get("idempotency-key");
  if (!key?.trim())
    throw new AppError(
      422,
      "VALIDATION_FAILED",
      "Idempotency-Key header is required",
    );
  return key.trim();
};

export const storeCommissionRoutes = (
  auth: AuthModule,
  service: StoreCommissionService,
) =>
  new Elysia({ name: "store-commission-routes" })
    .get(
      "/api/v1/dashboard/store-commissions",
      async ({ request, set, query }) =>
        service.list(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          query,
        ),
      {
        query: t.Object(
          {
            ...pageQuery,
            search: t.Optional(t.String({ maxLength: 200 })),
            status: t.Optional(
              t.Union([
                t.Literal("DRAFT"),
                t.Literal("ACTIVE"),
                t.Literal("INACTIVE"),
                t.Literal("ARCHIVED"),
              ]),
            ),
          },
          { additionalProperties: false },
        ),
        response: { 200: paginated(commissionDto), ...dashboardListErrors, 403: errorResponse },
        detail: {
          tags: ["Dashboard — Store Commissions"],
          summary: "List store platform commission rates",
          description:
            "Independent of store CRUD. Requires stores.commission.read. SUPER_ADMIN is blocked. City comes only from the signed token.",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/store-commissions/:storeId/history",
      async ({ request, set, params, query }) =>
        service.listHistory(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          query,
        ),
      {
        params: t.Object({ storeId: uuid }, { additionalProperties: false }),
        query: t.Object(pageQuery, { additionalProperties: false }),
        response: {
          200: paginated(historyDto),
          ...dashboardDetailErrors,
          403: errorResponse,
        },
        detail: {
          tags: ["Dashboard — Store Commissions"],
          summary: "List commission rate change timeline for a store",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .get(
      "/api/v1/dashboard/store-commissions/:storeId",
      async ({ request, set, params }) =>
        service.get(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
        ),
      {
        params: t.Object({ storeId: uuid }, { additionalProperties: false }),
        response: { 200: commissionDto, ...dashboardDetailErrors, 403: errorResponse },
        detail: {
          tags: ["Dashboard — Store Commissions"],
          summary: "Get one store platform commission rate",
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/store-commissions/:storeId",
      async ({ request, set, params, body }) => {
        assertAllowedBodyKeys(body, patchKeys);
        return service.update(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.storeId,
          body,
          idempotencyKeyOf(request),
          requestIdOf(set),
        );
      },
      {
        params: t.Object({ storeId: uuid }, { additionalProperties: false }),
        parse: "json",
        body: document(
          t.Object(
            {
              platformCommissionRate: t.Integer({ minimum: 0, maximum: 100 }),
              reason: t.String({ minLength: 1, maxLength: 1000 }),
              note: t.Optional(t.String({ maxLength: 1000 })),
            },
            { additionalProperties: true },
          ),
          orderExamples.commission,
        ),
        response: { 200: commissionDto, ...errors },
        detail: {
          tags: ["Dashboard — Store Commissions"],
          summary: "Update a store platform commission rate",
          description:
            "Requires stores.commission.update and Idempotency-Key. Same key and payload replay the stored result. Same key with a different rate or reason returns IDEMPOTENCY_KEY_REUSED. Equal rate does not write a fake history row.",
          security: [{ bearerAuth: [] }],
        },
      },
    );
