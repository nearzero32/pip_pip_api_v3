import { Elysia, status, t } from "elysia";
import type { AuthModule } from "../../auth-module";
import { customerContext } from "../../core/context";
import { bearer, deviceFields, errorResponse, ipOf, parseAuthenticationBody, rateLimiterUnavailableExample, refreshBody, requestIdOf, revokedResponse, sessionResponse, sessionsResponse, standardErrors } from "../../http/shared";
import { document } from "../../../../openapi/document";
import { authExamples, sessionExamples } from "../../../../openapi/examples/auth";
import { SAMPLE } from "../../../../openapi/samples";

const tag = ["Mobile — Customer Authentication"];
export const customerAuthRoutes = (auth: AuthModule) => new Elysia({ prefix: "/api/v1/mobile/customer/auth" })
  .onParse(parseAuthenticationBody)
  .post("/otp/request", async ({ body, request, set, server }) => {
    const requestId = requestIdOf(set);
    const challengeId = await auth.customer.requestOtp({ phone: body.phone, ip: ipOf(request, server), requestId });
    return status(202, { accepted: true, challenge_id: challengeId, request_id: requestId });
  }, { parse: "json", body: document(t.Object({ phone: t.String({ maxLength: 32 }) }, { additionalProperties: false }), authExamples.customerOtpRequest), response: { 202: document(t.Object({ accepted: t.Boolean(), challenge_id: t.String({ format: "uuid" }), request_id: t.String() }), { accepted: true, challenge_id: SAMPLE.challengeId, request_id: SAMPLE.requestId }), 422: errorResponse, 429: errorResponse, 503: document(errorResponse, rateLimiterUnavailableExample) }, detail: { tags: tag, summary: "Request Customer OTP" } })
  .post("/otp/verify", ({ body, request, set, server }) => auth.customer.verifyOtp({ challengeId: body.challenge_id, otp: body.otp, ...(body.device_id ? { deviceId: body.device_id } : {}), deviceName: body.device_name, ip: ipOf(request, server), requestId: requestIdOf(set) }), { parse: "json", body: document(t.Object({ challenge_id: t.String({ format: "uuid" }), otp: t.String({ pattern: "^[0-9]{6}$" }), ...deviceFields }, { additionalProperties: false }), authExamples.customerOtpVerify), response: { 200: document(sessionResponse, sessionExamples.customer), ...standardErrors }, detail: { tags: tag, summary: "Verify Customer OTP" } })
  .post("/token/refresh", ({ body, request, set, server }) => auth.sessions.refresh(body.refresh_token, customerContext, ipOf(request, server), requestIdOf(set)), { parse: "json", body: document(refreshBody, authExamples.refresh), response: { 200: document(sessionResponse, sessionExamples.customer), ...standardErrors }, detail: { tags: tag } })
  .post("/logout", async ({ request, set }) => { const id = requestIdOf(set); await auth.sessions.logout(await auth.sessions.identify(bearer(request), customerContext), customerContext, id); return { revoked: true, request_id: id }; }, { response: { 200: revokedResponse, ...standardErrors }, detail: { tags: tag, security: [{ bearerAuth: [] }] } })
  .post("/logout-all", async ({ request, set }) => { const id = requestIdOf(set); await auth.sessions.logoutAll(await auth.sessions.identify(bearer(request), customerContext), customerContext, id); return { revoked: true, request_id: id }; }, { response: { 200: revokedResponse, ...standardErrors }, detail: { tags: tag, security: [{ bearerAuth: [] }] } })
  .get("/sessions", async ({ request, set }) => ({ sessions: await auth.sessions.list(await auth.sessions.authenticate(bearer(request), customerContext, requestIdOf(set)), customerContext) }), { response: { 200: sessionsResponse, ...standardErrors }, detail: { tags: tag, security: [{ bearerAuth: [] }] } })
  .delete("/sessions/:sessionId", async ({ request, set, params }) => { const id = requestIdOf(set); await auth.sessions.revoke(await auth.sessions.authenticate(bearer(request), customerContext, id), params.sessionId, customerContext, id); return { revoked: true, request_id: id }; }, { params: t.Object({ sessionId: t.String({ format: "uuid", examples: [SAMPLE.sessionId] }) }, { additionalProperties: false }), response: { 200: revokedResponse, 404: errorResponse, ...standardErrors }, detail: { tags: tag, security: [{ bearerAuth: [] }] } });
