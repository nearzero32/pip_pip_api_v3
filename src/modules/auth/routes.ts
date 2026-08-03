import { Elysia, status, t } from "elysia";
import { AppError } from "../../errors/app-error";
import type { AuthService } from "./auth-service";

const appType = t.Union([t.Literal("CUSTOMER_APP"), t.Literal("DRIVER_APP")]);
const sessionAppType = t.Union([appType, t.Literal("DASHBOARD")]);
const errorResponse = t.Object({
  error: t.Object({ code: t.String(), message: t.String() }),
  request_id: t.String(),
});
const sessionResponse = t.Object({
  access_token: t.String(),
  access_token_expires_at: t.String({ format: "date-time" }),
  refresh_token: t.String(),
  session_id: t.String({ format: "uuid" }),
  application_type: sessionAppType,
});
const standardErrors = { 401: errorResponse, 422: errorResponse, 429: errorResponse, 500: errorResponse, 503: errorResponse };
const device = {
  device_id: t.Optional(t.String({ maxLength: 256 })),
  device_name: t.String({ minLength: 1, maxLength: 128 }),
};
const bearer = (header: string | null): string => {
  if (!header?.startsWith("Bearer ") || header.length > 8192)
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  return header.slice(7);
};
const ipOf = (request: Request, server: { requestIP(request: Request): { address: string } | null } | null): string =>
  (server?.requestIP(request)?.address ?? "unknown").slice(0, 64);
const requestIdOf = (set: {
  headers: Record<string, string | number | readonly string[]>;
}): string => String(set.headers["x-request-id"] ?? crypto.randomUUID());

export function authRoutes(service: AuthService) {
  const authenticate = async (request: Request, requestId: string) =>
    service.authenticate(bearer(request.headers.get("authorization")), requestId);
  const identify = async (request: Request) =>
    service.identifyAccessToken(bearer(request.headers.get("authorization")));
  return new Elysia({ prefix: "/api/v1/auth" })
    .post(
      "/phone/otp/request",
      async ({ body, request, set, server }) => {
        const requestId = requestIdOf(set);
        const challengeId = await service.requestOtp({
          phone: body.phone,
          applicationType: body.application_type,
          ip: ipOf(request, server),
          requestId,
        });
        return status(202, {
          accepted: true,
          challenge_id: challengeId,
          request_id: requestId,
        });
      },
      {
        body: t.Object({
          phone: t.String({ maxLength: 32 }),
          application_type: appType,
        }),
        response: { 202: t.Object({ accepted: t.Boolean(), challenge_id: t.String({ format: "uuid" }), request_id: t.String() }), 422: errorResponse, 429: errorResponse, 503: errorResponse },
        detail: { tags: ["Authentication"], summary: "Request phone OTP" },
      },
    )
    .post(
      "/phone/otp/verify",
      ({ body, request, set, server }) =>
        service.verifyOtp({
          challengeId: body.challenge_id,
          otp: body.otp,
          applicationType: body.application_type,
          deviceId: body.device_id,
          deviceName: body.device_name,
          ip: ipOf(request, server),
          requestId: requestIdOf(set),
        }),
      {
        body: t.Object({
          challenge_id: t.String({ format: "uuid" }),
          otp: t.String({ pattern: "^[0-9]{6}$" }),
          application_type: appType,
          ...device,
        }),
        response: { 200: sessionResponse, ...standardErrors },
        detail: { tags: ["Authentication"], summary: "Verify phone OTP" },
      },
    )
    .post(
      "/staff/login",
      ({ body, request, set, server }) =>
        service.staffLogin({
          email: body.email,
          password: body.password,
          deviceId: body.device_id,
          deviceName: body.device_name,
          ip: ipOf(request, server),
          requestId: requestIdOf(set),
        }),
      {
        body: t.Object({
          email: t.String({ maxLength: 254 }),
          password: t.String({ minLength: 12, maxLength: 128 }),
          ...device,
        }),
        response: { 200: sessionResponse, ...standardErrors },
        detail: { tags: ["Authentication"], summary: "Staff password login" },
      },
    )
    .post(
      "/token/refresh",
      ({ body, request, set, server }) =>
        service.refresh(body.refresh_token, ipOf(request, server), requestIdOf(set)),
      {
        body: t.Object({
          refresh_token: t.String({ minLength: 43, maxLength: 256 }),
        }),
        response: { 200: sessionResponse, ...standardErrors },
        detail: { tags: ["Authentication"], summary: "Rotate refresh token" },
      },
    )
    .post(
      "/logout",
      async ({ request, set }) => {
        const requestId = requestIdOf(set);
        await service.logout(await identify(request), requestId);
        return { revoked: true, request_id: requestId };
      },
      {
        response: { 200: t.Object({ revoked: t.Boolean(), request_id: t.String() }), ...standardErrors },
        detail: { tags: ["Authentication"], summary: "Logout current session" },
      },
    )
    .post(
      "/logout-all",
      async ({ request, set }) => {
        const requestId = requestIdOf(set);
        await service.logoutAll(await identify(request), requestId);
        return { revoked: true, request_id: requestId };
      },
      { response: { 200: t.Object({ revoked: t.Boolean(), request_id: t.String() }), ...standardErrors }, detail: { tags: ["Authentication"], summary: "Logout all sessions" } },
    )
    .get(
      "/sessions",
      async ({ request, set }) => ({
        sessions: await service.listSessions(await authenticate(request, requestIdOf(set))),
      }),
      { response: { 200: t.Object({ sessions: t.Array(t.Object({ id: t.String({ format: "uuid" }), application_type: sessionAppType, device_id: t.Nullable(t.String()), device_name: t.String(), created_at: t.String(), last_used_at: t.Nullable(t.String()), absolute_expires_at: t.String(), revoked_at: t.Nullable(t.String()) })) }), ...standardErrors }, detail: { tags: ["Authentication"], summary: "List owned sessions" } },
    )
    .delete(
      "/sessions/:sessionId",
      async ({ request, params, set }) => {
        const requestId = requestIdOf(set);
        await service.revokeSession(
          await authenticate(request, requestId),
          params.sessionId,
          requestId,
        );
        return { revoked: true, request_id: requestId };
      },
      {
        params: t.Object({ sessionId: t.String({ format: "uuid" }) }),
        response: { 200: t.Object({ revoked: t.Boolean(), request_id: t.String() }), 404: errorResponse, ...standardErrors },
        detail: { tags: ["Authentication"], summary: "Revoke owned session" },
      },
    );
}
