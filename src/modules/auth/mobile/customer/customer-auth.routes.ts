import { Elysia, status, t } from "elysia";
import type { AuthModule } from "../../auth-module";
import { customerContext } from "../../core/context";
import { bearer, deviceFields, errorResponse, ipOf, parseAuthenticationBody, refreshBody, requestIdOf, revokedResponse, sessionResponse, sessionsResponse, standardErrors } from "../../http/shared";

const tag = ["Mobile — Customer Authentication"];
export const customerAuthRoutes = (auth: AuthModule) => new Elysia({ prefix: "/api/v1/mobile/customer/auth" })
  .onParse(parseAuthenticationBody)
  .post("/otp/request", async ({ body, request, set, server }) => {
    const requestId = requestIdOf(set);
    const challengeId = await auth.customer.requestOtp({ phone: body.phone, ip: ipOf(request, server), requestId });
    return status(202, { accepted: true, challenge_id: challengeId, request_id: requestId });
  }, { body: t.Object({ phone: t.String({ maxLength: 32 }) }, { additionalProperties: false }), response: { 202: t.Object({ accepted: t.Boolean(), challenge_id: t.String({ format: "uuid" }), request_id: t.String() }), 422: errorResponse, 429: errorResponse, 503: errorResponse }, detail: { tags: tag, summary: "Request Customer OTP" } })
  .post("/otp/verify", ({ body, request, set, server }) => auth.customer.verifyOtp({ challengeId: body.challenge_id, otp: body.otp, ...(body.device_id ? { deviceId: body.device_id } : {}), deviceName: body.device_name, ip: ipOf(request, server), requestId: requestIdOf(set) }), { body: t.Object({ challenge_id: t.String({ format: "uuid" }), otp: t.String({ pattern: "^[0-9]{6}$" }), ...deviceFields }, { additionalProperties: false }), response: { 200: sessionResponse, ...standardErrors }, detail: { tags: tag, summary: "Verify Customer OTP" } })
  .post("/token/refresh", ({ body, request, set, server }) => auth.sessions.refresh(body.refresh_token, customerContext, ipOf(request, server), requestIdOf(set)), { body: refreshBody, response: { 200: sessionResponse, ...standardErrors }, detail: { tags: tag } })
  .post("/logout", async ({ request, set }) => { const id = requestIdOf(set); await auth.sessions.logout(await auth.sessions.identify(bearer(request), customerContext), customerContext, id); return { revoked: true, request_id: id }; }, { response: { 200: revokedResponse, ...standardErrors }, detail: { tags: tag, security: [{ bearerAuth: [] }] } })
  .post("/logout-all", async ({ request, set }) => { const id = requestIdOf(set); await auth.sessions.logoutAll(await auth.sessions.identify(bearer(request), customerContext), customerContext, id); return { revoked: true, request_id: id }; }, { response: { 200: revokedResponse, ...standardErrors }, detail: { tags: tag, security: [{ bearerAuth: [] }] } })
  .get("/sessions", async ({ request, set }) => ({ sessions: await auth.sessions.list(await auth.sessions.authenticate(bearer(request), customerContext, requestIdOf(set)), customerContext) }), { response: { 200: sessionsResponse, ...standardErrors }, detail: { tags: tag, security: [{ bearerAuth: [] }] } })
  .delete("/sessions/:sessionId", async ({ request, set, params }) => { const id = requestIdOf(set); await auth.sessions.revoke(await auth.sessions.authenticate(bearer(request), customerContext, id), params.sessionId, customerContext, id); return { revoked: true, request_id: id }; }, { params: t.Object({ sessionId: t.String({ format: "uuid" }) }, { additionalProperties: false }), response: { 200: revokedResponse, 404: errorResponse, ...standardErrors }, detail: { tags: tag, security: [{ bearerAuth: [] }] } });
