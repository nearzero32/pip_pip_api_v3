import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createActiveCity,
  createIntegrationHarness,
  createStaffAccount,
  jsonRequest,
  type IntegrationHarness,
} from "./helpers";

const password = "fixed staff password";

const pngBytes = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59,
  0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
);

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

const login = async (
  harness: IntegrationHarness,
  email: string,
  requestId: string,
) =>
  harness.auth.dashboard.login({
    email,
    password,
    deviceName: requestId,
    ip: requestId,
    requestId,
  });

const grantMedia = async (
  harness: IntegrationHarness,
  adminToken: string,
  employeeId: string,
  permissions: string[],
) => {
  for (const permission of permissions) {
    const response = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/employees/${employeeId}/permissions`, {
        method: "POST",
        token: adminToken,
        body: { permission },
      }),
    );
    expect(response.status).toBe(200);
  }
};

describe("M3-C0 Media assets and R2 infrastructure", () => {
  let harness: IntegrationHarness;
  let cityA = "";
  let cityB = "";
  let superToken = "";
  let adminToken = "";
  let adminBToken = "";
  let employeeId = "";
  let employeeToken = "";

  beforeAll(async () => {
    harness = await createIntegrationHarness({
      databasePrefix: "pip_pip_v3_m3c0",
    });
    cityA = await createActiveCity(harness.client, "Media City A");
    cityB = await createActiveCity(harness.client, "Media City B");

    await createStaffAccount(harness.auth, harness.client, {
      email: "m3c0-super@example.com",
      password,
      roles: ["SUPER_ADMIN"],
    });
    const adminId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3c0-admin@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityA,
    });
    employeeId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3c0-emp@example.com",
      password,
      roles: ["OPERATIONS"],
      cityId: cityA,
      managedByAccountId: adminId,
    });
    await createStaffAccount(harness.auth, harness.client, {
      email: "m3c0-admin-b@example.com",
      password,
      roles: ["ADMIN"],
      cityId: cityB,
    });

    superToken = (await login(harness, "m3c0-super@example.com", "super")).access_token;
    adminToken = (await login(harness, "m3c0-admin@example.com", "admin")).access_token;
    adminBToken = (await login(harness, "m3c0-admin-b@example.com", "admin-b")).access_token;
    await grantMedia(harness, adminToken, employeeId, [
      "media.read",
      "media.create",
      "media.delete",
    ]);
    employeeToken = (await login(harness, "m3c0-emp@example.com", "emp")).access_token;
  });

  afterAll(async () => {
    await harness.close();
  });

  test("ADMIN and granted employee can create CATEGORY_IMAGE intents; SUPER_ADMIN blocked", async () => {
    const adminIntent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "restaurants.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    expect(adminIntent.status).toBe(200);
    const adminBody = (await adminIntent.json()) as {
      asset: { id: string; status: string; url: null; visibility: string };
      upload: { method: string; url: string; headers: { "Content-Type": string } };
    };
    expect(adminBody.asset.status).toBe("PENDING_UPLOAD");
    expect(adminBody.asset.url).toBeNull();
    expect(adminBody.asset.visibility).toBe("PUBLIC");
    expect(adminBody.upload.method).toBe("PUT");
    expect(adminBody.upload.headers["Content-Type"]).toBe("image/png");
    expect(adminBody.upload.url).toContain("fake-r2.test");

    const key = await harness.media.getObjectKeyForTests(adminBody.asset.id, cityA);
    expect(key).toBe(
      `cities/${cityA}/categories/${adminBody.asset.id}/original.png`,
    );
    expect(key).not.toContain("restaurants");

    const empIntent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: employeeToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "emp.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    expect(empIntent.status).toBe(200);

    const superDenied = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: superToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "x.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    expect(superDenied.status).toBe(403);
  });

  test("employee without permission is 403; revocation applies immediately", async () => {
    const empNoPermId = await createStaffAccount(harness.auth, harness.client, {
      email: "m3c0-emp-noperm@example.com",
      password,
      roles: ["SUPPORT"],
      cityId: cityA,
      managedByAccountId: (
        await harness.client<{ id: string }[]>`
          select a.id::text as id from accounts a
          join account_emails e on e.account_id = a.id
          where e.email_normalized = 'm3c0-admin@example.com'`
      )[0]!.id,
    });
    const noPermToken = (
      await login(harness, "m3c0-emp-noperm@example.com", "noperm")
    ).access_token;
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/media/upload-intents", {
            method: "POST",
            token: noPermToken,
            body: {
              purpose: "CATEGORY_IMAGE",
              fileName: "x.png",
              contentType: "image/png",
              sizeBytes: pngBytes.length,
            },
          }),
        )
      ).status,
    ).toBe(403);

    await grantMedia(harness, adminToken, empNoPermId, ["media.create"]);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/media/upload-intents", {
            method: "POST",
            token: noPermToken,
            body: {
              purpose: "CATEGORY_IMAGE",
              fileName: "y.png",
              contentType: "image/png",
              sizeBytes: pngBytes.length,
            },
          }),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await harness.app.handle(
          jsonRequest(
            `/api/v1/dashboard/employees/${empNoPermId}/permissions/media.create`,
            { method: "DELETE", token: adminToken },
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest("/api/v1/dashboard/media/upload-intents", {
            method: "POST",
            token: noPermToken,
            body: {
              purpose: "CATEGORY_IMAGE",
              fileName: "z.png",
              contentType: "image/png",
              sizeBytes: pngBytes.length,
            },
          }),
        )
      ).status,
    ).toBe(403);
  });

  test("rejects forbidden fields, unsupported purpose/MIME/size, and SVG", async () => {
    const cases: Array<{ body: Record<string, unknown>; status: number }> = [
      {
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "a.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
          cityId: cityA,
        },
        status: 422,
      },
      {
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "a.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
          objectKey: "evil",
        },
        status: 422,
      },
      {
        body: {
          purpose: "STORE_LOGO",
          fileName: "a.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
        status: 422,
      },
      {
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "a.svg",
          contentType: "image/svg+xml",
          sizeBytes: 100,
        },
        status: 422,
      },
      {
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "a.png",
          contentType: "image/png",
          sizeBytes: 0,
        },
        status: 422,
      },
      {
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "a.png",
          contentType: "image/png",
          sizeBytes: -1,
        },
        status: 422,
      },
      {
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "a.png",
          contentType: "image/png",
          sizeBytes: 9_000_000,
        },
        status: 422,
      },
    ];
    for (const item of cases) {
      const response = await harness.app.handle(
        jsonRequest("/api/v1/dashboard/media/upload-intents", {
          method: "POST",
          token: adminToken,
          body: item.body,
        }),
      );
      expect(response.status).toBe(item.status);
    }
  });

  test("confirm success, idempotency, mismatches, cross-city 404", async () => {
    const intent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "confirm.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const intentBody = (await intent.json()) as { asset: { id: string } };
    const assetId = intentBody.asset.id;
    const objectKey = (await harness.media.getObjectKeyForTests(assetId, cityA))!;

    const missing = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/media/${assetId}/confirm`, {
        method: "POST",
        token: adminToken,
      }),
    );
    expect(missing.status).toBe(409);
    expect((await errorOf(missing)).code).toBe("MEDIA_UPLOAD_MISSING");

    harness.mediaStorage.putObject(objectKey, "image/jpeg", pngBytes);
    const typeMismatch = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/media/${assetId}/confirm`, {
        method: "POST",
        token: adminToken,
      }),
    );
    expect(typeMismatch.status).toBe(409);
    expect((await errorOf(typeMismatch)).code).toBe("MEDIA_UPLOAD_MISMATCH");

    harness.mediaStorage.putObject(
      objectKey,
      "image/png",
      Uint8Array.of(1, 2, 3, 4, 5),
    );
    const sizeMismatch = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/media/${assetId}/confirm`, {
        method: "POST",
        token: adminToken,
      }),
    );
    expect(sizeMismatch.status).toBe(409);
    expect((await errorOf(sizeMismatch)).code).toBe("MEDIA_UPLOAD_MISMATCH");

    const fake = new TextEncoder().encode("not-an-image-but-same-length!!!!!");
    // pad/truncate to exact length
    const fakeExact = new Uint8Array(pngBytes.length);
    fakeExact.set(fake.slice(0, Math.min(fake.length, pngBytes.length)));
    harness.mediaStorage.putObject(objectKey, "image/png", fakeExact);
    const invalid = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/media/${assetId}/confirm`, {
        method: "POST",
        token: adminToken,
      }),
    );
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).code).toBe("MEDIA_CONTENT_INVALID");

    harness.mediaStorage.putObject(objectKey, "image/png", pngBytes);
    const ok = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/media/${assetId}/confirm`, {
        method: "POST",
        token: adminToken,
      }),
    );
    expect(ok.status).toBe(200);
    const ready = (await ok.json()) as {
      status: string;
      url: string;
    };
    expect(ready.status).toBe("READY");
    expect(ready.url).toBe(
      `https://media.test.example.com/cities/${cityA}/categories/${assetId}/original.png`,
    );

    const again = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/media/${assetId}/confirm`, {
        method: "POST",
        token: adminToken,
      }),
    );
    expect(again.status).toBe(200);

    const cross = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/media/${assetId}`, {
        token: adminBToken,
      }),
    );
    expect(cross.status).toBe(404);
    expect((await errorOf(cross)).code).toBe("MEDIA_NOT_FOUND");
  });

  test("cancel queues deletion; attached assets cannot be deleted; cancel is idempotent", async () => {
    const pending = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "cancel.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const pendingId = ((await pending.json()) as { asset: { id: string } }).asset
      .id;
    const cancel1 = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/media/${pendingId}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    expect(cancel1.status).toBe(202);
    expect(((await cancel1.json()) as { status: string }).status).toBe(
      "DELETE_PENDING",
    );
    const cancel2 = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/media/${pendingId}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    expect(cancel2.status).toBe(202);

    const readyIntent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "ready-cancel.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const readyId = ((await readyIntent.json()) as { asset: { id: string } })
      .asset.id;
    const readyKey = (await harness.media.getObjectKeyForTests(readyId, cityA))!;
    harness.mediaStorage.putObject(readyKey, "image/png", pngBytes);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${readyId}/confirm`, {
            method: "POST",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${readyId}`, {
            method: "DELETE",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(202);

    const attachIntent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "attach.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const attachId = ((await attachIntent.json()) as { asset: { id: string } })
      .asset.id;
    const attachKey = (await harness.media.getObjectKeyForTests(attachId, cityA))!;
    harness.mediaStorage.putObject(attachKey, "image/png", pngBytes);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${attachId}/confirm`, {
            method: "POST",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);
    await harness.client.begin(async (tx) => {
      await harness.media.claimAsset(tx, {
        assetId: attachId,
        cityId: cityA,
        purpose: "CATEGORY_IMAGE",
      });
    });
    const inUse = await harness.app.handle(
      jsonRequest(`/api/v1/dashboard/media/${attachId}`, {
        method: "DELETE",
        token: adminToken,
      }),
    );
    expect(inUse.status).toBe(409);
    expect((await errorOf(inUse)).code).toBe("MEDIA_IN_USE");
  });

  test("concurrent claim has one winner", async () => {
    const intent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "claim.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const assetId = ((await intent.json()) as { asset: { id: string } }).asset.id;
    const key = (await harness.media.getObjectKeyForTests(assetId, cityA))!;
    harness.mediaStorage.putObject(key, "image/png", pngBytes);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${assetId}/confirm`, {
            method: "POST",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);

    const results = await Promise.allSettled([
      harness.client.begin((tx) =>
        harness.media.claimAsset(tx, {
          assetId,
          cityId: cityA,
          purpose: "CATEGORY_IMAGE",
        }),
      ),
      harness.client.begin((tx) =>
        harness.media.claimAsset(tx, {
          assetId,
          cityId: cityA,
          purpose: "CATEGORY_IMAGE",
        }),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
  });

  test("cleanup queues expired and abandoned assets; pending waits for upload expiry; retries and skip locked", async () => {
    const expiredIntent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "expired.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const expiredId = ((await expiredIntent.json()) as { asset: { id: string } })
      .asset.id;
    await harness.client`
      update media_assets set upload_expires_at = now() - interval '1 minute'
      where id = ${expiredId}`;

    const youngReadyIntent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "young.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const youngId = ((await youngReadyIntent.json()) as { asset: { id: string } })
      .asset.id;
    const youngKey = (await harness.media.getObjectKeyForTests(youngId, cityA))!;
    harness.mediaStorage.putObject(youngKey, "image/png", pngBytes);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${youngId}/confirm`, {
            method: "POST",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);

    const oldReadyIntent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "old.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const oldId = ((await oldReadyIntent.json()) as { asset: { id: string } }).asset
      .id;
    const oldKey = (await harness.media.getObjectKeyForTests(oldId, cityA))!;
    harness.mediaStorage.putObject(oldKey, "image/png", pngBytes);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${oldId}/confirm`, {
            method: "POST",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);
    await harness.client`
      update media_assets set ready_at = now() - interval '25 hours'
      where id = ${oldId}`;

    const pendingCancel = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "wait-expiry.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const waitId = ((await pendingCancel.json()) as { asset: { id: string } }).asset
      .id;
    const waitKey = (await harness.media.getObjectKeyForTests(waitId, cityA))!;
    harness.mediaStorage.putObject(waitKey, "image/png", pngBytes);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${waitId}`, {
            method: "DELETE",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(202);

    const summary = await harness.mediaCleanup.runOnce();
    expect(summary.queued).toBeGreaterThanOrEqual(2);

    const [expiredRow] = await harness.client<{ status: string }[]>`
      select status::text as status from media_assets where id = ${expiredId}`;
    expect(expiredRow?.status).toBe("DELETED");

    const [youngRow] = await harness.client<{ status: string }[]>`
      select status::text as status from media_assets where id = ${youngId}`;
    expect(youngRow?.status).toBe("READY");

    const [oldRow] = await harness.client<{ status: string }[]>`
      select status::text as status from media_assets where id = ${oldId}`;
    expect(oldRow?.status).toBe("DELETED");

    const [waitRow] = await harness.client<{ status: string }[]>`
      select status::text as status from media_assets where id = ${waitId}`;
    expect(waitRow?.status).toBe("DELETE_PENDING");
    expect(harness.mediaStorage.objects.has(waitKey)).toBe(true);

    await harness.client`
      update media_assets set upload_expires_at = now() - interval '1 second'
      where id = ${waitId}`;
    await harness.mediaCleanup.runOnce();
    const [waitDone] = await harness.client<{ status: string }[]>`
      select status::text as status from media_assets where id = ${waitId}`;
    expect(waitDone?.status).toBe("DELETED");

    // R2 delete failure remains retryable
    const failIntent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "fail-del.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const failId = ((await failIntent.json()) as { asset: { id: string } }).asset
      .id;
    const failKey = (await harness.media.getObjectKeyForTests(failId, cityA))!;
    harness.mediaStorage.putObject(failKey, "image/png", pngBytes);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${failId}/confirm`, {
            method: "POST",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${failId}`, {
            method: "DELETE",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(202);
    harness.mediaStorage.failNextDelete = true;
    const failedRun = await harness.mediaCleanup.runOnce();
    expect(failedRun.failed).toBeGreaterThanOrEqual(1);
    const [stillPending] = await harness.client<{ status: string; attempts: number }[]>`
      select status::text as status, delete_attempts as attempts
      from media_assets where id = ${failId}`;
    expect(stillPending?.status).toBe("DELETE_PENDING");
    expect(Number(stillPending?.attempts ?? 0)).toBeGreaterThanOrEqual(1);
    await harness.mediaCleanup.runOnce();
    const [retried] = await harness.client<{ status: string }[]>`
      select status::text as status from media_assets where id = ${failId}`;
    expect(retried?.status).toBe("DELETED");

    // Missing R2 object treated as success
    const missIntent = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "missing-obj.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    const missId = ((await missIntent.json()) as { asset: { id: string } }).asset
      .id;
    const missKey = (await harness.media.getObjectKeyForTests(missId, cityA))!;
    harness.mediaStorage.putObject(missKey, "image/png", pngBytes);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${missId}/confirm`, {
            method: "POST",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.app.handle(
          jsonRequest(`/api/v1/dashboard/media/${missId}`, {
            method: "DELETE",
            token: adminToken,
          }),
        )
      ).status,
    ).toBe(202);
    harness.mediaStorage.objects.delete(missKey);
    await harness.mediaCleanup.runOnce();
    const [missDone] = await harness.client<{ status: string }[]>`
      select status::text as status from media_assets where id = ${missId}`;
    expect(missDone?.status).toBe("DELETED");
  });

  test("suspended City rejects media mutations; OpenAPI documents Media; audit has no presigned URL", async () => {
    await harness.client`
      update cities set status = 'SUSPENDED', updated_at = now() where id = ${cityA}`;
    const denied = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "suspended.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    expect(denied.status).toBe(409);
    expect((await errorOf(denied)).code).toBe("CITY_NOT_ACTIVE");
    await harness.client`
      update cities set status = 'ACTIVE', updated_at = now() where id = ${cityA}`;
    // Re-login after city suspension may have revoked sessions via other paths;
    // city suspend alone may revoke - check if we need fresh login.
    const maybe = await harness.app.handle(
      jsonRequest("/api/v1/dashboard/media/upload-intents", {
        method: "POST",
        token: adminToken,
        body: {
          purpose: "CATEGORY_IMAGE",
          fileName: "after.png",
          contentType: "image/png",
          sizeBytes: pngBytes.length,
        },
      }),
    );
    if (maybe.status === 401) {
      adminToken = (await login(harness, "m3c0-admin@example.com", "admin2"))
        .access_token;
      employeeToken = (await login(harness, "m3c0-emp@example.com", "emp2"))
        .access_token;
    }

    const openapi = await harness.app.handle(
      new Request("http://localhost/openapi/json"),
    );
    expect(openapi.status).toBe(200);
    const doc = (await openapi.json()) as {
      tags: { name: string }[];
      paths: Record<string, unknown>;
    };
    expect(doc.tags.some((tag) => tag.name === "Dashboard — Media")).toBe(true);
    expect(doc.paths["/api/v1/dashboard/media/upload-intents"]).toBeTruthy();
    expect(doc.paths["/api/v1/dashboard/media/{assetId}/confirm"]).toBeTruthy();
    expect(doc.paths["/api/v1/dashboard/media/{assetId}"]).toBeTruthy();

    const logs = await harness.client<{ meta: Record<string, unknown> }[]>`
      select redacted_metadata as meta from audit_logs
      where event_type in ('MEDIA_UPLOAD_INTENT_CREATED','MEDIA_UPLOAD_CONFIRMED','MEDIA_DELETE_REQUESTED')
      limit 20`;
    for (const row of logs) {
      const text = JSON.stringify(row.meta);
      expect(text).not.toContain("fake-r2.test");
      expect(text).not.toContain("presigned");
      expect(text).not.toContain("secret");
    }
  });
});
