import type { SQL } from "bun";

export const authAuditEvents = ["OTP_REQUESTED", "OTP_REQUEST_RATE_LIMITED", "OTP_VERIFICATION_SUCCEEDED", "OTP_VERIFICATION_FAILED", "OTP_CHALLENGE_EXHAUSTED", "CUSTOMER_SESSION_CREATED", "DRIVER_LOGIN_SUCCEEDED", "DRIVER_LOGIN_FAILED", "DRIVER_SESSION_REPLACED", "STAFF_LOGIN_SUCCEEDED", "STAFF_LOGIN_FAILED", "SESSION_REFRESHED", "REFRESH_TOKEN_REUSE_DETECTED", "SESSION_REVOKED", "ALL_SESSIONS_REVOKED", "AUTHENTICATION_STATE_DENIED"] as const;
export type AuthAuditEvent = typeof authAuditEvents[number];
export interface AuditInput { event: AuthAuditEvent; outcome: "SUCCESS" | "FAILURE" | "DENIED"; requestId: string; accountId?: string; sessionId?: string; reasonCode?: string; applicationType?: string }
export class SecurityAuditWriter {
  constructor(private client: SQL) {}
  async write(input: AuditInput): Promise<void> {
    const metadata = input.applicationType ? { application_type: input.applicationType } : {};
    await this.client`insert into audit_logs (event_type, actor_account_id, actor_session_id, outcome, reason_code, request_correlation_id, redacted_metadata) values (${input.event}, ${input.accountId ?? null}, ${input.sessionId ?? null}, ${input.outcome}::audit_outcome, ${input.reasonCode ?? null}, ${input.requestId}, ${JSON.stringify(metadata)}::jsonb)`;
  }
}
