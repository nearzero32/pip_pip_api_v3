import { Elysia, t } from "elysia";
import type { AuthModule } from "../../auth-module";
import { driverContext } from "../../core/context";
import { bearer, deviceFields, errorResponse, ipOf, parseAuthenticationBody, refreshBody, requestIdOf, revokedResponse, sessionResponse, sessionsResponse, standardErrors } from "../../http/shared";
import { document } from "../../../../openapi/document";
import { authExamples, sessionExamples } from "../../../../openapi/examples/auth";

const tag = ["Mobile — Driver Authentication"];

export type DriverAuthRouteOptions = {
  /** Clear Redis runtime after logout so cache miss cannot resurrect AVAILABLE. */
  invalidateDriverRuntime?: (driverId: string) => Promise<void>;
};

export const driverAuthRoutes = (
  auth: AuthModule,
  options: DriverAuthRouteOptions = {},
) =>
  new Elysia({ prefix: "/api/v1/mobile/driver/auth" })
    .onParse(parseAuthenticationBody)
    .post(
      "/login",
      ({ body, request, set, server }) =>
        auth.driver.login({
          phone: body.phone,
          code: body.code,
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
            code: t.String({
              minLength: 6,
              maxLength: 12,
              pattern: "^[0-9]{6,12}$",
            }),
            ...deviceFields,
          },
          { additionalProperties: false },
        ),
          authExamples.driverLogin,
        ),
        response: { 200: document(sessionResponse, sessionExamples.driver), ...standardErrors },
        detail: { tags: tag, summary: "Driver phone and access-code login" },
      },
    )
    .post(
      "/token/refresh",
      ({ body, request, set, server }) =>
        auth.sessions.refresh(
          body.refresh_token,
          driverContext,
          ipOf(request, server),
          requestIdOf(set),
        ),
      {
        parse: "json",
        body: document(refreshBody, authExamples.refresh),
        response: { 200: document(sessionResponse, sessionExamples.driver), ...standardErrors },
        detail: { tags: tag },
      },
    )
    .post(
      "/logout",
      async ({ request, set }) => {
        const id = requestIdOf(set);
        const identity = await auth.sessions.identify(
          bearer(request),
          driverContext,
        );
        await auth.sessions.logout(identity, driverContext, id);
        await options.invalidateDriverRuntime?.(identity.accountId);
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
            driverContext,
            requestIdOf(set),
          ),
          driverContext,
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
          await auth.sessions.authenticate(bearer(request), driverContext, id),
          params.sessionId,
          driverContext,
          id,
        );
        return { revoked: true, request_id: id };
      },
      {
        params: t.Object(
          { sessionId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        response: { 200: revokedResponse, 404: errorResponse, ...standardErrors },
        detail: { tags: tag, security: [{ bearerAuth: [] }] },
      },
    );
