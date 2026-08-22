import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Ed25519AccessTokenService } from "../../src/modules/auth/tokens/access-token";
import { encodeBase64Url } from "../../src/modules/auth/shared/encoding";
import {
  createActiveCity,
  createDriverAccount,
  createIntegrationHarness,
  createStaffAccount,
  integrationConfig,
  jsonRequest,
  referencesRoleTables,
  seededGovernorateId,
  tokenClaims,
  type IntegrationHarness,
} from "./helpers";

describe("Token-based SUPER_ADMIN authorization (full HTTP path)", () => {
  let harness: IntegrationHarness & { trackedQueries?: string[] };
  const password = "fixed staff password";
  let cityId = "";
  let cityAdminId = "";
  const cityBoundary = { type: "Polygon", coordinates: [[[44, 33], [45, 33], [45, 34], [44, 34], [44, 33]]] };
  const cityTranslations = (ar: string, en: string) => [{ locale: "ar", name: ar }, { locale: "en", name: en }];

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      trackClient: true,
      databasePrefix: "pip_pip_v3_authz",
    });
    cityId = await createActiveCity(harness.client, "Authz City");
    cityAdminId = await createStaffAccount(harness.auth, harness.client, {
      email: "city-admin-owner@example.com",
      password,
      roles: ["ADMIN"],
      cityId,
    });
  }, 30000);

  afterAll(async () => {
    await harness.close();
  });

  const loginDashboard = async (email: string) => {
    const tag = email.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 64);
    return harness.auth.dashboard.login({
      email,
      password,
      deviceName: "browser",
      ip: `ip-${tag}`.slice(0, 64),
      requestId: `req-${tag}`.slice(0, 128),
    });
  };

  const createSupport = (email: string) =>
    createStaffAccount(harness.auth, harness.client, {
      email,
      password,
      roles: ["SUPPORT"],
      cityId,
      managedByAccountId: cityAdminId,
    });

  test("1-2 SUPER_ADMIN geography mutation succeeds and HTTP path does not query roles tables", async () => {
    const email = "super-admin-http@example.com";
    await createStaffAccount(harness.auth, harness.client, {
      email,
      password,
      roles: ["SUPER_ADMIN"],
    });
    const session = await loginDashboard(email);
    expect(tokenClaims(session.access_token).roles).toEqual(["SUPER_ADMIN"]);
    expect(tokenClaims(session.access_token).scopeType).toBe("GLOBAL");
    expect(tokenClaims(session.access_token).cityId).toBeNull();

    harness.trackedQueries!.length = 0;
    const response = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/cities", {
        method: "POST",
        token: session.access_token,
        body: {
          governorateId: seededGovernorateId,
          translations: cityTranslations("مدينة اختبار صلاحيات", "Authz HTTP City"),
          latitude: 33.3,
          longitude: 44.4,
          displayOrder: 1,
          boundary: cityBoundary,
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; nameEn: string };
    expect(body.status).toBe("DRAFT");
    expect(body.nameEn).toBe("Authz HTTP City");
    const roleQueries = harness.trackedQueries!.filter(referencesRoleTables);
    expect(roleQueries).toEqual([]);
  });

  test("3 non-SUPER_ADMIN Dashboard token receives 403", async () => {
    const email = "support-http@example.com";
    await createSupport(email);
    const session = await loginDashboard(email);
    expect(tokenClaims(session.access_token).scopeType).toBe("CITY");
    expect(tokenClaims(session.access_token).cityId).toBe(cityId);
    const response = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
        method: "PATCH",
        token: session.access_token,
        body: { status: "INACTIVE" },
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe(
      "FORBIDDEN",
    );
  });

  test("4-5 Customer and Driver tokens cannot access Dashboard Geography routes", async () => {
    harness.clock.advance();
    const challenge = await harness.auth.customer.requestOtp({
      phone: "+9647703100001",
      ip: "cust",
      requestId: "cust",
    });
    const customer = await harness.auth.customer.verifyOtp({
      challengeId: challenge,
      otp: harness.delivery.deliveries.at(-1)!.otp,
      deviceName: "c",
      ip: "cust-v",
      requestId: "cust-v",
    });
    expect(tokenClaims(customer.access_token).roles).toEqual([]);
    const customerGeo = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/cities", {
        method: "POST",
        token: customer.access_token,
        body: {
          governorateId: seededGovernorateId,
          translations: cityTranslations("x", "x"),
          latitude: 33.2,
          longitude: 44.2,
          displayOrder: 0,
          boundary: cityBoundary,
        },
      }),
    );
    expect(customerGeo.status).toBe(401);

    await createDriverAccount(harness.client, "+9647703100010", "123456");
    const driver = await harness.auth.driver.login({
      phone: "+9647703100010",
      code: "123456",
      deviceName: "d",
      ip: "drv",
      requestId: "drv",
    });
    expect(tokenClaims(driver.access_token).roles).toEqual([]);
    const driverGeo = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/governorates/${seededGovernorateId}`, {
        method: "PATCH",
        token: driver.access_token,
        body: { displayOrder: 2 },
      }),
    );
    expect(driverGeo.status).toBe(401);
  });

  test("6-7 Dashboard role claims are ignored for non-Dashboard audiences; forged claims fail", async () => {
    const tokens = new Ed25519AccessTokenService({
      issuer: integrationConfig.jwtIssuer,
      keyId: integrationConfig.jwtKeyId,
      privateKeyBase64: integrationConfig.jwtPrivateKeyBase64,
      publicKeyBase64: integrationConfig.jwtPublicKeyBase64,
      lifetimeSeconds: integrationConfig.accessTokenLifetimeSeconds,
    });
    const accountId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const customerWithRoles = await tokens.sign({
      accountId,
      sessionId,
      applicationType: "CUSTOMER_APP",
      roles: ["SUPER_ADMIN"],
    });
    expect(
      (await tokens.verify(customerWithRoles.token, "CUSTOMER_APP")).roles,
    ).toEqual([]);
    await expect(
      tokens.verify(customerWithRoles.token, "DASHBOARD"),
    ).rejects.toThrow();

    const email = "forge-http@example.com";
    const account = await createSupport(email);
    const session = await loginDashboard(email);
    const [header, , signature] = session.access_token.split(".") as [
      string,
      string,
      string,
    ];
    const claims = tokenClaims(session.access_token);
    claims.roles = ["SUPER_ADMIN"];
    claims.scopeType = "GLOBAL";
    claims.cityId = null;
    const forged = `${header}.${encodeBase64Url(JSON.stringify(claims))}.${signature}`;
    const forgedResponse = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/cities", {
        method: "POST",
        token: forged,
        body: {
          governorateId: seededGovernorateId,
          translations: cityTranslations("y", "y"),
          latitude: 33.2,
          longitude: 44.2,
          displayOrder: 0,
          boundary: cityBoundary,
        },
      }),
    );
    expect(forgedResponse.status).toBe(401);
    expect(account).toBeTruthy();
  });

  test("8 roles supplied through body, query, or ordinary headers have no effect", async () => {
    const email = "header-roles@example.com";
    await createSupport(email);
    const session = await loginDashboard(email);
    const response = await harness.app.handle(
      jsonRequest(
        `/api/v1/dashboard/governorates/${seededGovernorateId}?roles=SUPER_ADMIN`,
        {
          method: "PATCH",
          token: session.access_token,
          headers: {
            "x-roles": "SUPER_ADMIN",
            roles: "SUPER_ADMIN",
          },
          body: {
            status: "INACTIVE",
            roles: ["SUPER_ADMIN"],
            isSuperAdmin: true,
          },
        },
      ),
    );
    expect([403, 422]).toContain(response.status);
    if (response.status === 403) {
      expect(
        (await response.json() as { error: { code: string } }).error.code,
      ).toBe("FORBIDDEN");
    }
  });

  test("9-11 removing SUPER_ADMIN via canonical role service revokes sessions; access and refresh fail", async () => {
    const email = "revoke-super@example.com";
    const accountId = await createStaffAccount(harness.auth, harness.client, {
      email,
      password,
      roles: ["SUPER_ADMIN"],
    });
    const session = await loginDashboard(email);
    const result = await harness.auth.roles.revokeRole({
      accountId,
      roleCode: "SUPER_ADMIN",
      revokedByAccountId: accountId,
    });
    expect(result).toEqual({ changed: true, sessionsRevoked: true });

    const [row] = await harness.client<
      { revoked_at: Date | null; revocation_reason: string | null }[]
    >`select revoked_at,revocation_reason from sessions where id=${session.session_id}`;
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.revocation_reason).toBe("ROLE_ASSIGNMENT_CHANGED");

    const accessDenied = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/governorates", {
        token: session.access_token,
      }),
    );
    expect(accessDenied.status).toBe(401);

    await expect(
      harness.auth.sessions.refresh(
        session.refresh_token,
        {
          applicationType: "DASHBOARD",
          audience: "dashboard",
          namespace: "dashboard",
        },
        "refresh-revoked",
        "refresh-revoked",
      ),
    ).rejects.toMatchObject({ publicCode: "INVALID_REFRESH_TOKEN" });
  });

  test("12-13 assigning SUPER_ADMIN revokes old sessions; new login receives GLOBAL scope", async () => {
    const email = "assign-role@example.com";
    const accountId = await createSupport(email);
    const before = await loginDashboard(email);
    expect(tokenClaims(before.access_token).roles).toEqual(["SUPPORT"]);

    await harness.auth.roles.revokeRole({
      accountId,
      roleCode: "SUPPORT",
      revokedByAccountId: accountId,
    });
    const assigned = await harness.auth.roles.assignRole({
      accountId,
      roleCode: "SUPER_ADMIN",
      grantedByAccountId: accountId,
    });
    expect(assigned).toEqual({ changed: true, sessionsRevoked: true });

    await expect(
      harness.auth.sessions.refresh(
        before.refresh_token,
        {
          applicationType: "DASHBOARD",
          audience: "dashboard",
          namespace: "dashboard",
        },
        "assign-refresh",
        "assign-refresh",
      ),
    ).rejects.toMatchObject({ publicCode: "INVALID_REFRESH_TOKEN" });

    const after = await loginDashboard(email);
    expect(tokenClaims(after.access_token).roles).toEqual(["SUPER_ADMIN"]);
    expect(tokenClaims(after.access_token).scopeType).toBe("GLOBAL");
    expect(tokenClaims(after.access_token).cityId).toBeNull();
    const identity = await harness.auth.sessions.authenticate(
      after.access_token,
      {
        applicationType: "DASHBOARD",
        audience: "dashboard",
        namespace: "dashboard",
      },
      "after-assign",
    );
    expect(identity.roles).toEqual(["SUPER_ADMIN"]);
    expect(identity.scopeType).toBe("GLOBAL");
  });

  test("14 Customer and Driver tokens and identities contain no Dashboard role claims", async () => {
    harness.clock.advance();
    const challenge = await harness.auth.customer.requestOtp({
      phone: "+9647703100099",
      ip: "c14",
      requestId: "c14",
    });
    const customer = await harness.auth.customer.verifyOtp({
      challengeId: challenge,
      otp: harness.delivery.deliveries.at(-1)!.otp,
      deviceName: "c14",
      ip: "c14v",
      requestId: "c14v",
    });
    expect(tokenClaims(customer.access_token).roles).toEqual([]);
    const customerIdentity = await harness.auth.sessions.authenticate(
      customer.access_token,
      {
        applicationType: "CUSTOMER_APP",
        audience: "customer-app",
        namespace: "customer",
      },
      "c14a",
    );
    expect(customerIdentity.roles).toEqual([]);

    await createDriverAccount(harness.client, "+9647703100098", "654321");
    const driver = await harness.auth.driver.login({
      phone: "+9647703100098",
      code: "654321",
      deviceName: "d14",
      ip: "d14",
      requestId: "d14",
    });
    expect(tokenClaims(driver.access_token).roles).toEqual([]);
    const driverIdentity = await harness.auth.sessions.authenticate(
      driver.access_token,
      {
        applicationType: "DRIVER_APP",
        audience: "driver-app",
        namespace: "driver",
      },
      "d14a",
    );
    expect(driverIdentity.roles).toEqual([]);
  });

  test("idempotent role assign/revoke does not revoke sessions", async () => {
    const email = "idempotent-roles@example.com";
    const accountId = await createSupport(email);
    const session = await loginDashboard(email);
    const again = await harness.auth.roles.assignRole({
      accountId,
      roleCode: "SUPPORT",
      grantedByAccountId: accountId,
      cityId,
    });
    expect(again).toEqual({ changed: false, sessionsRevoked: false });
    const [row] = await harness.client<
      { revoked_at: Date | null }[]
    >`select revoked_at from sessions where id=${session.session_id}`;
    expect(row!.revoked_at).toBeNull();

    await harness.auth.roles.revokeRole({
      accountId,
      roleCode: "SUPPORT",
      revokedByAccountId: accountId,
    });
    const noop = await harness.auth.roles.revokeRole({
      accountId,
      roleCode: "SUPPORT",
      revokedByAccountId: accountId,
    });
    expect(noop).toEqual({ changed: false, sessionsRevoked: false });
  });

  test("valid Dashboard refresh reloads current City scope from the database", async () => {
    const email = "refresh-roles-http@example.com";
    await createStaffAccount(harness.auth, harness.client, {
      email,
      password,
      roles: ["ADMIN"],
      cityId,
    });
    const session = await loginDashboard(email);
    const refreshed = await harness.auth.sessions.refresh(
      session.refresh_token,
      {
        applicationType: "DASHBOARD",
        audience: "dashboard",
        namespace: "dashboard",
      },
      "refresh-ok",
      "refresh-ok",
    );
    expect(tokenClaims(refreshed.access_token).roles).toEqual(["ADMIN"]);
    expect(tokenClaims(refreshed.access_token).scopeType).toBe("CITY");
    expect(tokenClaims(refreshed.access_token).cityId).toBe(cityId);
  });
});
