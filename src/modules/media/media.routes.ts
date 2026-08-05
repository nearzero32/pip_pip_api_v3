import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import { dashboardContext } from "../auth/core/context";
import {
  errorResponse,
  parseAuthenticationBody,
  standardErrors,
} from "../auth/http/shared";
import {
  assertAllowedBodyKeys,
  authIdentity,
  dateSchema,
  requestIdOf,
} from "../geography/shared";
import type { MediaService } from "./media.service";

const mediaStatus = t.Union([
  t.Literal("PENDING_UPLOAD"),
  t.Literal("READY"),
  t.Literal("DELETE_PENDING"),
  t.Literal("DELETED"),
]);

const mediaPurpose = t.Union([
  t.Literal("CATEGORY_IMAGE"),
  t.Literal("STORE_LOGO"),
  t.Literal("STORE_IMAGE"),
]);

const mediaAssetDto = t.Object({
  id: t.String({ format: "uuid" }),
  status: mediaStatus,
  purpose: t.String(),
  visibility: t.Union([t.Literal("PUBLIC"), t.Literal("PRIVATE")]),
  originalName: t.String(),
  contentType: t.String(),
  sizeBytes: t.Number(),
  url: t.Nullable(t.String()),
  uploadExpiresAt: t.Nullable(dateSchema),
  readyAt: t.Nullable(dateSchema),
  attachedAt: t.Nullable(dateSchema),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

const uploadIntentResponse = t.Object({
  asset: mediaAssetDto,
  upload: t.Object({
    method: t.Literal("PUT"),
    url: t.String(),
    headers: t.Object({ "Content-Type": t.String() }),
    expiresAt: dateSchema,
  }),
});

const assetIdParam = t.Object(
  { assetId: t.String({ format: "uuid" }) },
  { additionalProperties: false },
);

const intentBodyKeys = new Set(["purpose", "fileName", "contentType", "sizeBytes"]);

const mediaErrors = {
  ...standardErrors,
  400: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  410: errorResponse,
  429: errorResponse,
  503: errorResponse,
};

const parseMediaBody = async (context: {
  request: Request;
  contentType: string;
}) => {
  const body = await parseAuthenticationBody(context);
  const path = new URL(context.request.url).pathname;
  const method = context.request.method.toUpperCase();
  if (method === "POST" && path.endsWith("/dashboard/media/upload-intents")) {
    assertAllowedBodyKeys(body, intentBodyKeys);
  }
  return body;
};

export const mediaRoutes = (auth: AuthModule, service: MediaService) =>
  new Elysia({ name: "media-routes" })
    .onParse(parseMediaBody)
    .post(
      "/api/v1/dashboard/media/upload-intents",
      async ({ request, set, body }) =>
        service.createUploadIntent(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          body,
          requestIdOf(set),
        ),
      {
        body: t.Object(
          {
            purpose: mediaPurpose,
            fileName: t.String({ minLength: 1, maxLength: 255 }),
            contentType: t.String({ minLength: 1, maxLength: 100 }),
            sizeBytes: t.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
        response: { 200: uploadIntentResponse, ...mediaErrors },
        detail: {
          tags: ["Dashboard — Media"],
          security: [{ bearerAuth: [] }],
          summary: "Create a media upload intent and presigned PUT URL",
          description:
            "Supports CATEGORY_IMAGE, STORE_LOGO, and STORE_IMAGE. Visibility is server-assigned PUBLIC for these purposes.",
        },
      },
    )
    .post(
      "/api/v1/dashboard/media/:assetId/confirm",
      async ({ request, set, params }) =>
        service.confirm(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.assetId,
          requestIdOf(set),
        ),
      {
        params: assetIdParam,
        response: { 200: mediaAssetDto, ...mediaErrors },
        detail: {
          tags: ["Dashboard — Media"],
          security: [{ bearerAuth: [] }],
          summary: "Confirm an uploaded media object and mark it READY",
        },
      },
    )
    .get(
      "/api/v1/dashboard/media/:assetId",
      async ({ request, set, params }) =>
        service.get(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.assetId,
        ),
      {
        params: assetIdParam,
        response: { 200: mediaAssetDto, ...mediaErrors },
        detail: {
          tags: ["Dashboard — Media"],
          security: [{ bearerAuth: [] }],
          summary: "Get City-scoped media asset metadata",
        },
      },
    )
    .delete(
      "/api/v1/dashboard/media/:assetId",
      async ({ request, set, params }) => {
        const body = await service.delete(
          await authIdentity(auth, request, dashboardContext, requestIdOf(set)),
          params.assetId,
          requestIdOf(set),
        );
        set.status = 202;
        return body;
      },
      {
        params: assetIdParam,
        response: { 202: mediaAssetDto, ...mediaErrors },
        detail: {
          tags: ["Dashboard — Media"],
          security: [{ bearerAuth: [] }],
          summary: "Queue deletion of an unattached media asset",
        },
      },
    );
