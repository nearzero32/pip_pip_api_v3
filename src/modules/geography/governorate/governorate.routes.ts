import { Elysia, t } from "elysia";
import type { AuthModule } from "../../auth/auth-module";
import { dashboardContext } from "../../auth/core/context";
import { parseAuthenticationBody } from "../../auth/http/shared";
import {
  dashboardPaginated,
  dashboardListQuery,
} from "../../dashboard-lists/query";
import {
  assertAllowedBodyKeys,
  authIdentity,
  dashboardListErrors,
  dashboardMutationErrors,
  dateSchema,
  requestIdOf,
} from "../shared";
import type { GovernorateService } from "./governorate.service";

const govDto = t.Object({
  id: t.String({ format: "uuid" }),
  nameAr: t.String(),
  nameEn: t.String(),
  status: t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")]),
  displayOrder: t.Integer(),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});
const govResponse = dashboardPaginated(govDto);
const idParam = t.Object(
  { governorateId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const patchKeys = new Set(["status", "displayOrder"]);

const parseGovernorateBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  if (
    context.request.method.toUpperCase() === "PATCH" &&
    /\/dashboard\/governorates\/[^/]+$/.test(path)
  ) {
    assertAllowedBodyKeys(body, patchKeys);
  }
  return body;
};

export const governorateRoutes = (
  auth: AuthModule,
  service: GovernorateService,
) =>
  new Elysia({ name: "governorate-routes" })
    .onParse(parseGovernorateBody)
    .get(
      "/api/v1/dashboard/governorates",
      async ({ request, set, query }) => {
        await authIdentity(auth, request, dashboardContext, requestIdOf(set));
        return service.list(query);
      },
      {
        query: t.Object(
          {
            ...dashboardListQuery,
            status: t.Optional(
              t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")], {
                description: "Filter by governorate status",
                examples: ["ACTIVE"],
              }),
            ),
          },
          { additionalProperties: false },
        ),
        response: { 200: govResponse, ...dashboardListErrors },
        detail: {
          tags: ["Dashboard — Governorates"],
          security: [{ bearerAuth: [] }],
        },
      },
    )
    .patch(
      "/api/v1/dashboard/governorates/:governorateId",
      async ({ request, set, params, body }) => {
        const identity = await authIdentity(
          auth,
          request,
          dashboardContext,
          requestIdOf(set),
        );
        return service.update(identity, params.governorateId, body);
      },
      {
        params: idParam,
        parse: "json",
        body: t.Object(
          {
            status: t.Optional(
              t.Union([t.Literal("ACTIVE"), t.Literal("INACTIVE")]),
            ),
            displayOrder: t.Optional(t.Integer({ minimum: 0 })),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: govDto, ...dashboardMutationErrors },
        detail: {
          tags: ["Dashboard — Governorates"],
          security: [{ bearerAuth: [] }],
        },
      },
    );
