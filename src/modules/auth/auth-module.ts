import type { SQL } from "bun";
import type { AppConfig } from "../../config/env";
import { SecurityAuditWriter } from "./audit/audit-writer";
import { DashboardAuthService } from "./dashboard/dashboard-auth.service";
import { CustomerAuthService } from "./mobile/customer/customer-auth.service";
import { DriverAuthService } from "./mobile/driver/driver-auth.service";
import type { OtpDeliveryPort } from "./phone/delivery";
import type { RateLimiter } from "./rate-limit/rate-limiter";
import { SessionService } from "./sessions/session-service";
import { HmacSecretVerifier } from "./shared/secret-verifier";
import { Argon2PasswordHasher } from "./staff/password";
import { DashboardRoleService } from "./staff/dashboard-roles";
import { StaffOrganizationService } from "./staff/staff-organization.service";
import { Ed25519AccessTokenService } from "./tokens/access-token";

export interface AuthModule {
  customer: CustomerAuthService;
  driver: DriverAuthService;
  dashboard: DashboardAuthService;
  sessions: SessionService;
  roles: DashboardRoleService;
  staff: StaffOrganizationService;
  client: SQL;
}

export function createAuthModule(
  client: SQL,
  limiter: RateLimiter,
  delivery: OtpDeliveryPort,
  config: AppConfig,
): AuthModule {
  const verifier = new HmacSecretVerifier(
    config.secretVerifierKeyVersion,
    config.secretVerifierKey,
  );
  const password = new Argon2PasswordHasher({
    memoryCost: config.argon2MemoryCost,
    timeCost: config.argon2TimeCost,
    parallelism: config.argon2Parallelism,
  });
  const tokens = new Ed25519AccessTokenService({
    issuer: config.jwtIssuer,
    keyId: config.jwtKeyId,
    privateKeyBase64: config.jwtPrivateKeyBase64,
    publicKeyBase64: config.jwtPublicKeyBase64,
    lifetimeSeconds: config.accessTokenLifetimeSeconds,
  });
  const audit = new SecurityAuditWriter(client);
  const sessions = new SessionService(
    client,
    limiter,
    verifier,
    tokens,
    audit,
  );
  const roles = new DashboardRoleService(client);
  const staff = new StaffOrganizationService(client, password);
  return {
    client,
    sessions,
    roles,
    staff,
    customer: new CustomerAuthService(
      client,
      limiter,
      delivery,
      verifier,
      sessions,
      audit,
    ),
    driver: new DriverAuthService(
      client,
      limiter,
      password,
      verifier,
      sessions,
      audit,
    ),
    dashboard: new DashboardAuthService(
      client,
      limiter,
      password,
      verifier,
      sessions,
      audit,
    ),
  };
}
