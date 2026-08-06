import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  tokenClaims,
  type IntegrationHarness,
} from "./helpers";
import { customerContext, dashboardContext, driverContext, merchantContext } from "../../src/modules/auth/core/context";

const password = "fixed staff password";
const merchantPassword = "merchant-pass-12";
const merchantPassword2 = "merchant-pass-99";

const pngBytes = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
  0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
);

const square = (west: number, south: number, east: number, north: number) => ({
  type: "Polygon" as const,
  coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
});

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error;

describe("Merchant accounts and auth", () => {
  let harness: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let storeA = "";
  let storeA2 = "";
  let storeB = "";
  let merchantAccountId = "";
  const phoneShared = "+9647708800001";
  const phoneOnlyMerchant = "+9647708800002";
  const phoneSecond = "+9647708800003";

  const login = async (email: string, requestId: string) =>
    harness.auth.dashboard.login({
      email,
      password,
      deviceName: requestId,
      ip: requestId,
      requestId,
    });

  const createReadyAsset = async (
    token: string,
    purpose: "CATEGORY_IMAGE" | "STORE_LOGO" | "PRODUCT_IMAGE",
    fileName: string,
    city: string,
  ) => {
    const intent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token,
        body: {
          purpose,
          fileName,
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    expect(intent.status).toBe(200);
    const body = (await intent.json()) as { asset: { id: string } };
    const objectKey = await harness.media.getObjectKeyForTests(body.asset.id, city);
    harness.mediaStorage.putObject(objectKey!, "image/png", pngBytes);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${body.asset.id}/confirm`, {
            method: "POST",
            token,
          }),
        )
      ).status,
    ).toBe(200);
    return body.asset.id;
  };

  const createStore = async (token: string, city: string, name: string, phone: string) => {
    const n = Number(phone.slice(-4));
    const west = (city === cityB ? 50 : 40) + n * 0.2;
    const south = (city === cityB ? 30 : 20) + n * 0.2;
    const zone = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/zones", {
        method: "POST",
        token,
        body: {
          name: `MZ-${phone.slice(-4)}`,
          boundary: square(west, south, west + 0.1, south + 0.1),
        },
      }),
    );
    expect(zone.status).toBe(200);
    const zoneId = ((await zone.json()) as { id: string }).id;
    const main = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/main-categories", {
        method: "POST",
        token,
        body: {
          name: `م-${phone.slice(-4)}`,
          imageAssetId: await createReadyAsset(token, "CATEGORY_IMAGE", `${phone}.png`, city),
          status: "ACTIVE",
          displayOrder: 1,
        },
      }),
    );
    expect(main.status).toBe(200);
    const mainId = ((await main.json()) as { id: string }).id;
    const sub = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/subcategories", {
        method: "POST",
        token,
        body: {
          mainCategoryId: mainId,
          name: `ف-${phone.slice(-4)}`,
          status: "ACTIVE",
          displayOrder: 1,
        },
      }),
    );
    expect(sub.status).toBe(200);
    const subId = ((await sub.json()) as { id: string }).id;
    const store = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/stores", {
        method: "POST",
        token,
        body: {
          mainCategoryId: mainId,
          name,
          phone,
          address: "عنوان",
          latitude: south + 0.02,
          longitude: west + 0.02,
          logoAssetId: await createReadyAsset(token, "STORE_LOGO", `l-${phone}.png`, city),
          zoneIds: [zoneId],
          subcategoryIds: [subId],
          status: "ACTIVE",
        },
      }),
    );
    expect(store.status).toBe(200);
    return ((await store.json()) as { id: string }).id;
  };

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_merchant",
    });
    cityA = await createActiveCity(harness.client, "Merchant City A");
    cityB = await createActiveCity(harness.client, "Merchant City B");

    await createStaffAccount(harness.auth, harness.client, {
      email: "m-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "m-admin@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "m-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });

    superToken = (await login("m-super@example.com", "super")).access_token;
    adminToken = (await login("m-admin@example.com", "admin")).access_token;
    adminBToken = (await login("m-admin-b@example.com", "admin-b")).access_token;

    storeA = await createStore(adminToken, cityA, "متجر تاجر أ", "+9647708810001");
    storeA2 = await createStore(adminToken, cityA, "متجر تاجر أ٢", "+9647708810002");
    storeB = await createStore(adminBToken, cityB, "متجر تاجر ب", "+9647708810003");

    harness.clock.advance();
    const challenge = await harness.auth.customer.requestOtp({
      phone: phoneShared,
      ip: "cust-m",
      requestId: "cust-m",
    });
    await harness.auth.customer.verifyOtp({
      challengeId: challenge,
      otp: harness.delivery.deliveries.at(-1)!.otp,
      deviceName: "c",
      ip: "cust-m",
      requestId: "cust-m-v",
    });
    const [sharedAccount] = await harness.client<{ account_id: string }[]>`
      select account_id::text as account_id from account_phones
      where phone_e164 = ${phoneShared}`;
    const [reviewer] = await harness.client<{ id: string }[]>`
      insert into accounts default values returning id::text as id`;
    const [application] = await harness.client<{ id: string }[]>`
      insert into driver_applications(
        account_id, status, decided_at, decided_by_account_id
      ) values (
        ${sharedAccount!.account_id}, 'APPROVED', now(), ${reviewer!.id}
      ) returning id::text as id`;
    const { Argon2PasswordHasher } = await import(
      "../../src/modules/auth/staff/password"
    );
    const hasher = new Argon2PasswordHasher({
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    await harness.client`
      insert into driver_profiles(
        account_id, approved_application_id, operational_status,
        driver_photo_object_key, access_code_hash
      ) values (
        ${sharedAccount!.account_id},
        ${application!.id},
        'ACTIVE',
        'photo',
        ${await hasher.hash("123456")}
      )`;
  }, 120000);

  afterAll(async () => {
    await harness.close();
  });

  test("ADMIN creates Merchant; SUPER_ADMIN and cross-city Store rejected", async () => {
    const blocked = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/merchants", {
        method: "POST",
        token: superToken,
        body: {
          phone: phoneOnlyMerchant,
          password: merchantPassword,
          storeId: storeA,
        },
      }),
    );
    expect(blocked.status).toBe(403);

    const cross = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/merchants", {
        method: "POST",
        token: adminToken,
        body: {
          phone: phoneOnlyMerchant,
          password: merchantPassword,
          storeId: storeB,
        },
      }),
    );
    expect(cross.status).toBe(404);
    expect((await errorOf(cross)).code).toBe("STORE_NOT_FOUND");

    const created = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/merchants", {
        method: "POST",
        token: adminToken,
        body: {
          phone: phoneShared,
          password: merchantPassword,
          storeId: storeA,
          displayName: "تاجر ١",
        },
      }),
    );
    expect(created.status).toBe(200);
    const body = (await created.json()) as {
      accountId: string;
      storeId: string;
      cityId: string;
      phone: string;
      status: string;
    };
    merchantAccountId = body.accountId;
    expect(body.storeId).toBe(storeA);
    expect(body.cityId).toBe(cityA);
    expect(body.phone).toBe(phoneShared);
    expect(body.status).toBe("ACTIVE");

    const dup = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/merchants", {
        method: "POST",
        token: adminToken,
        body: {
          phone: phoneShared,
          password: merchantPassword,
          storeId: storeA2,
        },
      }),
    );
    expect(dup.status).toBe(409);

    const second = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/merchants", {
        method: "POST",
        token: adminToken,
        body: {
          phone: phoneSecond,
          password: merchantPassword,
          storeId: storeA,
        },
      }),
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { storeId: string }).storeId).toBe(storeA);
  });

  test("Merchant login, JWT audience, and cross-app isolation", async () => {
    harness.clock.advance();
    const bad = await harness.app.handle(
      jsonRequest("/api/v1/mobile/merchant/auth/login", {
        method: "POST",
        body: {
          phone: phoneShared,
          password: "wrong-password-x",
          device_name: "m1",
        },
      }),
    );
    expect(bad.status).toBe(401);

    const loginOk = await harness.app.handle(
      jsonRequest("/api/v1/mobile/merchant/auth/login", {
        method: "POST",
        body: {
          phone: phoneShared,
          password: merchantPassword,
          device_id: "dev-1",
          device_name: "m1",
        },
      }),
    );
    expect(loginOk.status).toBe(200);
    const session = (await loginOk.json()) as {
      access_token: string;
      application_type: string;
      refresh_token: string;
    };
    expect(session.application_type).toBe("MERCHANT_APP");
    const claims = tokenClaims(session.access_token);
    expect(claims.app).toBe("MERCHANT_APP");
    expect(claims.aud).toBe("merchant-app");
    expect(claims.cityId).toBe(cityA);
    expect(claims.storeId).toBe(storeA);

    await expect(
      harness.auth.sessions.authenticate(
        session.access_token,
        customerContext,
        "x",
      ),
    ).rejects.toThrow();
    await expect(
      harness.auth.sessions.authenticate(
        session.access_token,
        driverContext,
        "x",
      ),
    ).rejects.toThrow();
    await expect(
      harness.auth.sessions.authenticate(
        session.access_token,
        dashboardContext,
        "x",
      ),
    ).rejects.toThrow();

    const staffOnMerchant = await harness.app.handle(
      jsonRequest("/api/v1/mobile/merchant/auth/me", {
        token: adminToken,
      }),
    );
    expect(staffOnMerchant.status).toBe(401);

    harness.clock.advance();
    const customerToken = (
      await harness.auth.customer.verifyOtp({
        challengeId: await harness.auth.customer.requestOtp({
          phone: phoneShared,
          ip: "c2",
          requestId: "c2",
        }),
        otp: harness.delivery.deliveries.at(-1)!.otp,
        deviceName: "c2",
        ip: "c2",
        requestId: "c2v",
      })
    ).access_token;
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/mobile/merchant/products", {
            token: customerToken,
          }),
        )
      ).status,
    ).toBe(401);

    const driverToken = (
      await harness.auth.driver.login({
        phone: phoneShared,
        code: "123456",
        deviceName: "d",
        ip: "d",
        requestId: "d",
      })
    ).access_token;
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/mobile/merchant/categories", {
            token: driverToken,
          }),
        )
      ).status,
    ).toBe(401);

    const me = await harness.app.handle(
      jsonRequest("/api/v1/mobile/merchant/auth/me", {
        token: session.access_token,
      }),
    );
    expect(me.status).toBe(200);
    expect(((await me.json()) as { store: { id: string } }).store.id).toBe(storeA);
  });

  test("Merchant catalog isolation and open/closed", async () => {
    harness.clock.advance();
    const session = await harness.auth.merchant.login({
      phone: phoneShared,
      password: merchantPassword,
      deviceId: "cat-1",
      deviceName: "cat",
      ip: "cat",
      requestId: "cat",
    });

    const category = await harness.app.handle(
      jsonRequest("/api/v1/mobile/merchant/categories", {
        method: "POST",
        token: session.access_token,
        body: { name: "مشروبات تاجر", displayOrder: 1 },
      }),
    );
    expect(category.status).toBe(200);

    const otherStoreProduct = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/stores/${storeA2}/products`, {
        token: session.access_token,
      }),
    );
    expect(otherStoreProduct.status).toBe(401);

    const foreignPath = await harness.products.list(
      {
        accountId: merchantAccountId,
        sessionId: session.session_id,
        applicationType: "MERCHANT_APP",
        roles: [],
        scopeType: null,
        cityId: cityA,
        storeId: storeA,
      },
      storeA2,
      {},
    ).then(
      () => "ok",
      (e: { publicCode?: string }) => e.publicCode ?? "ERR",
    );
    expect(foreignPath).toBe("STORE_NOT_FOUND");

    const paused = await harness.app.handle(
      jsonRequest("/api/v1/mobile/merchant/store/order-acceptance", {
        method: "PATCH",
        token: session.access_token,
        body: { orderAcceptanceStatus: "PAUSED" },
      }),
    );
    expect(paused.status).toBe(200);
    expect(
      ((await paused.json()) as { orderAcceptanceStatus: string })
        .orderAcceptanceStatus,
    ).toBe("PAUSED");

    const group = await harness.app.handle(
      jsonRequest("/api/v1/mobile/merchant/modifier-groups", {
        method: "POST",
        token: session.access_token,
        body: {
          name: "إضافات",
          minSelect: 0,
          maxSelect: 2,
          options: [{ name: "جبن", isAvailable: true, displayOrder: 0 }],
        },
      }),
    );
    expect(group.status).toBe(200);
  });

  test("Device limit 3 with oldest replacement; status and transfer revoke sessions", async () => {
    harness.clock.advance();
    const tokens: string[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await harness.auth.merchant.login({
        phone: phoneShared,
        password: merchantPassword,
        deviceId: `limit-${i}`,
        deviceName: `limit-${i}`,
        ip: `limit-${i}`,
        requestId: `limit-${i}`,
      });
      tokens.push(s.access_token);
    }
    const active = Number(
      (
        await harness.client<{ count: string }[]>`
          select count(*)::text as count from sessions
          where account_id = ${merchantAccountId}
            and application_type = 'MERCHANT_APP'
            and revoked_at is null`
      )[0]!.count,
    );
    expect(active).toBe(3);
    await expect(
      harness.auth.sessions.authenticate(tokens[0]!, merchantContext, "old"),
    ).rejects.toThrow();
    await harness.auth.sessions.authenticate(tokens[3]!, merchantContext, "new");

    const beforeSuspend = await harness.auth.merchant.login({
      phone: phoneShared,
      password: merchantPassword,
      deviceId: "sus",
      deviceName: "sus",
      ip: "sus",
      requestId: "sus",
    });
    const suspend = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/merchants/${merchantAccountId}`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "SUSPENDED" },
      }),
    );
    expect(suspend.status).toBe(200);
    await expect(
      harness.auth.sessions.authenticate(
        beforeSuspend.access_token,
        merchantContext,
        "sus-auth",
      ),
    ).rejects.toThrow();
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/mobile/merchant/auth/login", {
            method: "POST",
            body: {
              phone: phoneShared,
              password: merchantPassword,
              device_name: "blocked",
            },
          }),
        )
      ).status,
    ).toBe(401);

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/merchants/${merchantAccountId}`, {
            method: "PATCH",
            token: adminToken,
            body: { status: "ACTIVE" },
          }),
        )
      ).status,
    ).toBe(200);

    const beforeInactive = await harness.auth.merchant.login({
      phone: phoneShared,
      password: merchantPassword,
      deviceId: "ina",
      deviceName: "ina",
      ip: "ina",
      requestId: "ina",
    });
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/merchants/${merchantAccountId}`, {
            method: "PATCH",
            token: adminToken,
            body: { status: "INACTIVE" },
          }),
        )
      ).status,
    ).toBe(200);
    await expect(
      harness.auth.sessions.authenticate(
        beforeInactive.access_token,
        merchantContext,
        "ina-auth",
      ),
    ).rejects.toThrow();

    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/merchants/${merchantAccountId}`, {
            method: "PATCH",
            token: adminToken,
            body: { status: "ACTIVE" },
          }),
        )
      ).status,
    ).toBe(200);

    const beforeTransfer = await harness.auth.merchant.login({
      phone: phoneShared,
      password: merchantPassword,
      deviceId: "xfer",
      deviceName: "xfer",
      ip: "xfer",
      requestId: "xfer",
    });
    const crossTransfer = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/merchants/${merchantAccountId}/store`, {
        method: "POST",
        token: adminToken,
        body: { storeId: storeB },
      }),
    );
    expect(crossTransfer.status).toBe(404);

    const transfer = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/merchants/${merchantAccountId}/store`, {
        method: "POST",
        token: adminToken,
        body: { storeId: storeA2 },
      }),
    );
    expect(transfer.status).toBe(200);
    expect(((await transfer.json()) as { storeId: string }).storeId).toBe(storeA2);
    await expect(
      harness.auth.sessions.authenticate(
        beforeTransfer.access_token,
        merchantContext,
        "xfer-auth",
      ),
    ).rejects.toThrow();

    const after = await harness.auth.merchant.login({
      phone: phoneShared,
      password: merchantPassword,
      deviceId: "after",
      deviceName: "after",
      ip: "after",
      requestId: "after",
    });
    expect(tokenClaims(after.access_token).storeId).toBe(storeA2);
    const oldStoreList = await harness.products
      .list(
        {
          accountId: merchantAccountId,
          sessionId: after.session_id,
          applicationType: "MERCHANT_APP",
          roles: [],
          scopeType: null,
          cityId: cityA,
          storeId: storeA2,
        },
        storeA,
        {},
      )
      .then(
        () => "ok",
        (e: { publicCode?: string }) => e.publicCode ?? "ERR",
      );
    expect(oldStoreList).toBe("STORE_NOT_FOUND");
  });

  test("Password reset and self change", async () => {
    harness.clock.advance();
    const reset = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/merchants/${merchantAccountId}/password`, {
        method: "POST",
        token: adminToken,
        body: { password: merchantPassword2 },
      }),
    );
    expect(reset.status).toBe(200);
    expect(JSON.stringify(await reset.json())).not.toMatch(/merchant-pass/i);

    const crossCityReset = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/merchants/${merchantAccountId}/password`, {
        method: "POST",
        token: adminBToken,
        body: { password: "another-pass-12" },
      }),
    );
    expect(crossCityReset.status).toBe(404);

    const loginNew = await harness.auth.merchant.login({
      phone: phoneShared,
      password: merchantPassword2,
      deviceId: "pw",
      deviceName: "pw",
      ip: "pw",
      requestId: "pw",
    });

    const self = await harness.app.handle(
      jsonRequest("/api/v1/mobile/merchant/auth/password", {
        method: "POST",
        token: loginNew.access_token,
        body: {
          currentPassword: merchantPassword2,
          newPassword: merchantPassword,
        },
      }),
    );
    expect(self.status).toBe(200);
    await expect(
      harness.auth.sessions.authenticate(
        loginNew.access_token,
        merchantContext,
        "pw-changed",
      ),
    ).rejects.toThrow();

    await harness.auth.merchant.login({
      phone: phoneShared,
      password: merchantPassword,
      deviceId: "final",
      deviceName: "final",
      ip: "final",
      requestId: "final",
    });
  });
});
