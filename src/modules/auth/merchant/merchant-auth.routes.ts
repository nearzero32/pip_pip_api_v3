import { Elysia, t } from "elysia";
import type { AuthModule } from "../auth-module";
import { merchantContext } from "../core/context";
import {
  bearer,
  deviceFields,
  errorResponse,
  ipOf,
  parseAuthenticationBody,
  refreshBody,
  requestIdOf,
  revokedResponse,
  sessionResponse,
  sessionsResponse,
  standardErrors,
} from "../http/shared";
import { document } from "../../../openapi/document";
import { authExamples, sessionExamples } from "../../../openapi/examples/auth";

const tag = ["Mobile — Merchant Authentication"];

const meResponse = t.Object({
  accountId: t.String({ format: "uuid" }),
  phone: t.Nullable(t.String()),
  displayName: t.Nullable(t.String()),
  status: t.Union([
    t.Literal("ACTIVE"),
    t.Literal("INACTIVE"),
    t.Literal("SUSPENDED"),
  ]),
  cityId: t.String({ format: "uuid" }),
  store: t.Object({
    id: t.String({ format: "uuid" }),
    name: t.String(),
    status: t.String(),
    orderAcceptanceStatus: t.String(),
  }),
});

export const merchantAuthRoutes = (auth: AuthModule) =>
  new Elysia({ prefix: "/api/v1/mobile/merchant/auth" })
    .onParse(parseAuthenticationBody)
    .post(
      "/login",
      ({ body, request, set, server }) =>
        auth.merchant.login({
          phone: body.phone,
          password: body.password,
          ...(body.device_id ? { deviceId: body.device_id } : {}),
          deviceName: body.device_name,
          ip: ipOf(request, server),
          requestId: requestIdOf(set),
        }),
      {
        parse: "json",
        body: document(
          t.Object(
          {
            phone: t.String({ maxLength: 32 }),
            password: t.String({ minLength: 12, maxLength: 128 }),
            ...deviceFields,
          },
          { additionalProperties: false },
        ),
          authExamples.merchantLogin,
        ),
        response: { 200: document(sessionResponse, sessionExamples.merchant), ...standardErrors },
        detail: {
          tags: tag,
          summary: "Merchant phone + password login",
          description:
            "Authenticates MERCHANT_APP only. Audience merchant-app. Same phone may independently exist as CUSTOMER/DRIVER.",
        },
      },
    )
    .post(
      "/token/refresh",
      ({ body, request, set, server }) =>
        auth.sessions.refresh(
          body.refresh_token,
          merchantContext,
          ipOf(request, server),
          requestIdOf(set),
        ),
      {
        parse: "json",
        body: document(refreshBody, authExamples.refresh),
        response: { 200: document(sessionResponse, sessionExamples.merchant), ...standardErrors },
        detail: { tags: tag },
      },
    )
    .post(
      "/logout",
      async ({ request, set }) => {
        const id = requestIdOf(set);
        await auth.sessions.logout(
          await auth.sessions.identify(bearer(request), merchantContext),
          merchantContext,
          id,
        );
        return { revoked: true, request_id: id };
      },
      {
        response: { 200: revokedResponse, ...standardErrors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .post(
      "/logout-all",
      async ({ request, set }) => {
        const id = requestIdOf(set);
        await auth.sessions.logoutAll(
          await auth.sessions.identify(bearer(request), merchantContext),
          merchantContext,
          id,
        );
        return { revoked: true, request_id: id };
      },
      {
        response: { 200: revokedResponse, ...standardErrors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .get(
      "/sessions",
      async ({ request, set }) => ({
        sessions: await auth.sessions.list(
          await auth.sessions.authenticate(
            bearer(request),
            merchantContext,
            requestIdOf(set),
          ),
          merchantContext,
        ),
      }),
      {
        response: { 200: sessionsResponse, ...standardErrors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .delete(
      "/sessions/:sessionId",
      async ({ request, set, params }) => {
        const id = requestIdOf(set);
        await auth.sessions.revoke(
          await auth.sessions.authenticate(
            bearer(request),
            merchantContext,
            id,
          ),
          params.sessionId,
          merchantContext,
          id,
        );
        return { revoked: true, request_id: id };
      },
      {
        params: t.Object(
          { sessionId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: {
          200: revokedResponse,
          404: errorResponse,
          ...standardErrors,
        },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    )
    .get(
      "/me",
      async ({ request, set }) =>
        auth.merchant.me(
          await auth.sessions.authenticate(
            bearer(request),
            merchantContext,
            requestIdOf(set),
          ),
        ),
      {
        response: { 200: meResponse, ...standardErrors },
        detail: {
          tags: tag,
          security: [{ bearerAuth: [] }],
          summary: "Current Merchant profile and trusted Store",
        },
      },
    )
    .post(
      "/password",
      async ({ request, set, body }) =>
        auth.merchant.changePassword(
          await auth.sessions.authenticate(
            bearer(request),
            merchantContext,
            requestIdOf(set),
          ),
          body,
          requestIdOf(set),
        ),
      {
        parse: "json",
        body: document(
          t.Object(
          {
            currentPassword: t.String({ minLength: 12, maxLength: 128 }),
            newPassword: t.String({ minLength: 12, maxLength: 128 }),
          },
          { additionalProperties: false },
        ),
          authExamples.merchantPassword,
        ),
        response: {
          200: t.Object({
            changed: t.Boolean(),
            request_id: t.String(),
          }),
          ...standardErrors,
        },
        detail: {
          tags: tag,
          security: [{ bearerAuth: [] }],
          summary: "Merchant self password change (revokes Merchant sessions)",
        },
      },
    );
