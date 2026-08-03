import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { AppConfig } from "../../src/config/env";
import { applyMigrations } from "../../src/db/migration-runner";
import { seedGovernorates } from "../../src/db/seed";
import { createAuthModule, type AuthModule } from "../../src/modules/auth/auth-module";
import {
  customerContext,
  dashboardContext,
  driverContext,
} from "../../src/modules/auth/core/context";
import { TestOtpDelivery } from "../../src/modules/auth/phone/delivery";
import { InMemoryRateLimiter } from "../../src/modules/auth/rate-limit/rate-limiter";
import { Argon2PasswordHasher } from "../../src/modules/auth/staff/password";
import { decodeBase64Url, encodeBase64Url } from "../../src/modules/auth/shared/encoding";
import { Ed25519AccessTokenService } from "../../src/modules/auth/tokens/access-token";
import { AppError } from "../../src/errors/app-error";
import { GeographyService } from "../../src/modules/geography/service";

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
if (!adminUrl) throw new Error("TEST_ADMIN_DATABASE_URL is required");
const parsed = new URL(adminUrl);
if (
  !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
  /prod/i.test(parsed.pathname)
)
  throw new Error("Unsafe integration database");

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  logLevel: "error",
  databaseUrl: adminUrl,
  databasePoolSize: 5,
  databaseConnectionTimeoutMs: 5000,
  gracefulShutdownTimeoutMs: 5000,
  redisUrl: "redis://localhost:6380",
  otpDeliveryAdapter: "test",
  secretVerifierKey: "integration-verifier-key-at-least-32-characters",
  secretVerifierKeyVersion: "v1",
  jwtIssuer: "integration",
  jwtKeyId: "integration-v1",
  jwtPrivateKeyBase64:
    "MC4CAQAwBQYDK2VwBCIEIOhYjslG5wawzghWHcQbYCMjFp8kzMYLVFZoKEOBzTA4",
  jwtPublicKeyBase64:
    "MCowBQYDK2VwAyEA+ly2CeP4N1AQ5vNUEt226L6GtOMU/uLE2rjFfo4OBCE=",
  accessTokenLifetimeSeconds: 600,
  argon2MemoryCost: 19456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
};

const governorateId = "11111111-1111-4111-8111-000000000001";
const tokenService = new Ed25519AccessTokenService({
  issuer: config.jwtIssuer,
  keyId: config.jwtKeyId,
  privateKeyBase64: config.jwtPrivateKeyBase64,
  publicKeyBase64: config.jwtPublicKeyBase64,
  lifetimeSeconds: config.accessTokenLifetimeSeconds,
});

const claimsOf = (token: string) =>
  JSON.parse(
    new TextDecoder().decode(decodeBase64Url(token.split(".")[1]!)),
  ) as Record<string, unknown>;

const trackQueries = (client: SQL) => {
  const queries: string[] = [];
  const tracked = new Proxy(client, {
    apply(target, thisArg, argArray) {
      const strings = argArray[0] as TemplateStringsArray;
      queries.push(strings.join(""));
      return Reflect.apply(target as (...args: unknown[]) => unknown, thisArg, argArray);
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  }) as SQL;
  return { client: tracked, queries };
};

describe("Token-based SUPER_ADMIN authorization", () => {
  const dbName = `pip_pip_v3_authz_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: SQL;
  let client: SQL;
  let delivery: TestOtpDelivery;
  let auth: AuthModule;
  let geography: GeographyService;
  let clock = Date.now();
  const advance = () => {
    clock += 3_600_001;
  };

  beforeAll(async () => {
    admin = new SQL(adminUrl!, { max: 1 });
    await admin.unsafe(`create database "${dbName}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    client = new SQL(url.toString(), { max: 12 });
    await applyMigrations(client);
    await seedGovernorates(client);
    delivery = new TestOtpDelivery();
    auth = createAuthModule(
      client,
      new InMemoryRateLimiter(() => clock),
      delivery,
      config,
    );
    geography = new GeographyService(client, auth.sessions);
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
    if (admin) {
      await admin.unsafe(`drop database if exists "${dbName}" with(force)`);
      await admin.close();
    }
  });

  const createStaff = async (
    email: string,
    password: string,
    roleCodes: string[],
  ) => {
    const [account] = await client<{ id: string }[]>`insert into accounts default values returning id`;
    await client`insert into account_emails(account_id,email_original,email_normalized,verified_at,is_primary)values(${account!.id},${email},${email.toLowerCase()},now(),true)`;
    await client`insert into staff_profiles(account_id,status)values(${account!.id},'ACTIVE')`;
    for (const code of roleCodes) {
      const [role] = await client<{ id: string }[]>`select id from roles where code=${code}::staff_role_code`;
      await client`insert into account_roles(account_id,role_id,granted_by_account_id)values(${account!.id},${role!.id},${account!.id})`;
    }
    const hash = await new Argon2PasswordHasher({
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    }).hash(password);
    await client`insert into password_credentials(account_id,argon2id_hash)values(${account!.id},${hash})`;
    return account!.id;
  };

  const createDriver = async (phone: string, code: string) => {
    const [account] = await client<{ id: string }[]>`insert into accounts default values returning id`;
    await client`insert into account_phones(account_id,phone_e164,verified_at,is_primary)values(${account!.id},${phone},now(),true)`;
    const [reviewer] = await client<{ id: string }[]>`insert into accounts default values returning id`;
    const [application] = await client<{ id: string }[]>`insert into driver_applications(account_id,status,decided_at,decided_by_account_id)values(${account!.id},'APPROVED',now(),${reviewer!.id})returning id`;
    const hasher = new Argon2PasswordHasher({
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    await client`insert into driver_profiles(account_id,approved_application_id,operational_status,driver_photo_object_key,access_code_hash)values(${account!.id},${application!.id},'ACTIVE','photo',${await hasher.hash(code)})`;
    return account!.id;
  };

  test("SUPER_ADMIN mutations do not query roles tables after authentication", async () => {
    const email = "super-admin@example.com";
    const password = "fixed staff password";
    await createStaff(email, password, ["SUPER_ADMIN"]);
    const login = await auth.dashboard.login({
      email,
      password,
      deviceName: "admin",
      ip: "roles-query",
      requestId: "roles-query",
    });
    const identity = await auth.sessions.authenticate(
      login.access_token,
      dashboardContext,
      "roles-query-auth",
    );
    expect(identity.roles).toContain("SUPER_ADMIN");

    const tracked = trackQueries(client);
    const trackedGeography = new GeographyService(tracked.client, auth.sessions);
    await trackedGeography.createCity(identity, {
      governorateId,
      nameAr: "مدينة صلاحيات",
      nameEn: "Authz City",
      latitude: 33.3,
      longitude: 44.4,
      displayOrder: 1,
    });
    const roleQueries = tracked.queries.filter(
      (sql) =>
        /\baccount_roles\b/i.test(sql) ||
        /\broles\b/i.test(sql),
    );
    expect(roleQueries).toEqual([]);
  });

  test("non-SUPER_ADMIN Dashboard tokens receive 403", async () => {
    const email = "support@example.com";
    const password = "fixed staff password";
    await createStaff(email, password, ["SUPPORT"]);
    const login = await auth.dashboard.login({
      email,
      password,
      deviceName: "support",
      ip: "support-403",
      requestId: "support-403",
    });
    const identity = await auth.sessions.authenticate(
      login.access_token,
      dashboardContext,
      "support-403-auth",
    );
    expect(identity.roles).toEqual(["SUPPORT"]);
    expect(claimsOf(login.access_token).roles).toEqual(["SUPPORT"]);
    await expect(
      geography.updateGovernorate(identity, governorateId, { status: "INACTIVE" }),
    ).rejects.toMatchObject({
      statusCode: 403,
      publicCode: "FORBIDDEN",
    } satisfies Partial<AppError>);
  });

  test("Customer and Driver tokens cannot use Dashboard roles", async () => {
    advance();
    const phone = "+9647703000001";
    const challenge = await auth.customer.requestOtp({
      phone,
      ip: "cust-roles",
      requestId: "cust-roles",
    });
    const customer = await auth.customer.verifyOtp({
      challengeId: challenge,
      otp: delivery.deliveries.at(-1)!.otp,
      deviceName: "c",
      ip: "cust-roles-v",
      requestId: "cust-roles-v",
    });
    expect(claimsOf(customer.access_token).roles).toEqual([]);
    const customerIdentity = await auth.sessions.authenticate(
      customer.access_token,
      customerContext,
      "cust-roles-auth",
    );
    expect(customerIdentity.roles).toEqual([]);
    expect(() => auth.sessions.requireSuperAdmin(customerIdentity)).toThrow(
      AppError,
    );
    expect(() =>
      auth.sessions.requireSuperAdmin({
        ...customerIdentity,
        roles: ["SUPER_ADMIN"],
      }),
    ).toThrow(AppError);

    await createDriver("+9647703000010", "123456");
    const driver = await auth.driver.login({
      phone: "+9647703000010",
      code: "123456",
      deviceName: "d",
      ip: "driver-roles",
      requestId: "driver-roles",
    });
    expect(claimsOf(driver.access_token).roles).toEqual([]);
    const driverIdentity = await auth.sessions.authenticate(
      driver.access_token,
      driverContext,
      "driver-roles-auth",
    );
    expect(driverIdentity.roles).toEqual([]);
    expect(() => auth.sessions.requireSuperAdmin(driverIdentity)).toThrow(
      AppError,
    );
    await expect(
      auth.sessions.authenticate(customer.access_token, dashboardContext, "cross"),
    ).rejects.toThrow();
  });

  test("modified or forged role claims are rejected", async () => {
    const email = "forge@example.com";
    const password = "fixed staff password";
    const accountId = await createStaff(email, password, ["SUPPORT"]);
    const login = await auth.dashboard.login({
      email,
      password,
      deviceName: "forge",
      ip: "forge",
      requestId: "forge",
    });
    const [header, payload, signature] = login.access_token.split(".") as [
      string,
      string,
      string,
    ];
    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(payload)),
    ) as Record<string, unknown>;
    claims.roles = ["SUPER_ADMIN"];
    const forged = `${header}.${encodeBase64Url(JSON.stringify(claims))}.${signature}`;
    await expect(
      auth.sessions.authenticate(forged, dashboardContext, "forged"),
    ).rejects.toMatchObject({ statusCode: 401, publicCode: "UNAUTHENTICATED" });

    const resigned = await tokenService.sign({
      accountId,
      sessionId: login.session_id,
      applicationType: "CUSTOMER_APP",
      roles: ["SUPER_ADMIN"],
    });
    const verified = await tokenService.verify(
      resigned.token,
      "CUSTOMER_APP",
    );
    expect(verified.roles).toEqual([]);
    await expect(
      tokenService.verify(resigned.token, "DASHBOARD"),
    ).rejects.toThrow();
  });

  test("role removal revokes existing Dashboard sessions", async () => {
    const email = "revoke-role@example.com";
    const password = "fixed staff password";
    const accountId = await createStaff(email, password, ["SUPER_ADMIN"]);
    const login = await auth.dashboard.login({
      email,
      password,
      deviceName: "revoke",
      ip: "revoke-role",
      requestId: "revoke-role",
    });
    await auth.sessions.authenticate(
      login.access_token,
      dashboardContext,
      "revoke-before",
    );
    await client`update account_roles set revoked_at=now(),revoked_by_account_id=${accountId},updated_at=now() where account_id=${accountId} and revoked_at is null`;
    await auth.sessions.revokeDashboardSessionsForRoleChange(accountId);
    const [session] = await client<
      { revoked_at: Date | null; revocation_reason: string | null }[]
    >`select revoked_at,revocation_reason from sessions where id=${login.session_id}`;
    expect(session!.revoked_at).not.toBeNull();
    expect(session!.revocation_reason).toBe("ROLE_ASSIGNMENT_CHANGED");
    await expect(
      auth.sessions.authenticate(login.access_token, dashboardContext, "revoke-after"),
    ).rejects.toMatchObject({ statusCode: 401, publicCode: "UNAUTHENTICATED" });
  });

  test("refresh tokens receive the current role set", async () => {
    const email = "refresh-roles@example.com";
    const password = "fixed staff password";
    const accountId = await createStaff(email, password, ["SUPPORT"]);
    const login = await auth.dashboard.login({
      email,
      password,
      deviceName: "refresh",
      ip: "refresh-roles",
      requestId: "refresh-roles",
    });
    expect(claimsOf(login.access_token).roles).toEqual(["SUPPORT"]);

    const [adminRole] = await client<{ id: string }[]>`select id from roles where code='SUPER_ADMIN'`;
    await client`insert into account_roles(account_id,role_id,granted_by_account_id)values(${accountId},${adminRole!.id},${accountId})`;

    const refreshed = await auth.sessions.refresh(
      login.refresh_token,
      dashboardContext,
      "refresh-roles-ip",
      "refresh-roles-req",
    );
    expect(claimsOf(refreshed.access_token).roles).toEqual([
      "SUPER_ADMIN",
      "SUPPORT",
    ]);
    const identity = await auth.sessions.authenticate(
      refreshed.access_token,
      dashboardContext,
      "refresh-roles-auth",
    );
    expect(identity.roles).toEqual(["SUPER_ADMIN", "SUPPORT"]);
  });
});
