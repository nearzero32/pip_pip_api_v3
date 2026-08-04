/**
 * One-shot real R2 smoke upload against local Bun API stack.
 * Uses .env R2 credentials. Does not print secrets or presigned URLs in full.
 */
import { SQL } from "bun";
import { loadConfig } from "../src/config/env";
import { dashboardContext } from "../src/modules/auth/core/context";
import { createAuthModule } from "../src/modules/auth/auth-module";
import { TestOtpDelivery } from "../src/modules/auth/phone/delivery";
import { InMemoryRateLimiter } from "../src/modules/auth/rate-limit/rate-limiter";
import { Argon2PasswordHasher } from "../src/modules/auth/staff/password";
import { MediaService } from "../src/modules/media/media.service";
import { R2MediaStorage } from "../src/modules/media/r2-media-storage";
import { createLogger } from "../src/observability/logger";
import { seedGovernorates } from "../src/db/seed";

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

const config = loadConfig();
const logger = createLogger("error");
const client = new SQL(config.databaseUrl, {
  max: 5,
  connectionTimeout: config.databaseConnectionTimeoutMs / 1000,
});

const main = async () => {
  await seedGovernorates(client);

  const [city] = await client<{ id: string }[]>`
    insert into cities(governorate_id,name_ar,name_en,latitude,longitude,status,display_order)
    values(
      '11111111-1111-4111-8111-000000000001',
      'Smoke City',
      'Smoke City',
      33.3,
      44.4,
      'ACTIVE',
      1
    )
    returning id::text as id`;

  const cityId = city!.id;
  const email = `smoke-admin-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "fixed staff password";

  const auth = createAuthModule(
    client,
    new InMemoryRateLimiter(),
    new TestOtpDelivery(),
    config,
  );

  const [account] = await client<{ id: string }[]>`
    insert into accounts default values returning id`;
  await client`
    insert into account_emails(account_id,email_original,email_normalized,verified_at,is_primary)
    values(${account!.id},${email},${email.toLowerCase()},now(),true)`;
  await client`
    insert into staff_profiles(account_id,status) values(${account!.id},'ACTIVE')`;
  const hash = await new Argon2PasswordHasher({
    memoryCost: config.argon2MemoryCost,
    timeCost: config.argon2TimeCost,
    parallelism: config.argon2Parallelism,
  }).hash(password);
  await client`
    insert into password_credentials(account_id,argon2id_hash)
    values(${account!.id},${hash})`;
  await auth.roles.assignRole({
    accountId: account!.id,
    roleCode: "ADMIN",
    grantedByAccountId: account!.id,
    cityId,
  });

  const session = await auth.dashboard.login({
    email,
    password,
    deviceName: "smoke",
    ip: "127.0.0.1",
    requestId: "smoke-upload",
  });

  const identity = await auth.sessions.authenticate(
    session.access_token,
    dashboardContext,
    "smoke-auth",
  );

  const storage = new R2MediaStorage(config);
  const media = new MediaService(client, storage, config, logger);

  const intent = await media.createUploadIntent(
    identity,
    {
      purpose: "CATEGORY_IMAGE",
      fileName: "smoke.png",
      contentType: "image/png",
      sizeBytes: pngBytes.length,
    },
    "smoke-intent",
  );

  const putFile = `/tmp/smoke-r2-${intent.asset.id}.png`;
  await Bun.write(putFile, pngBytes);
  const putProc = Bun.spawn(
    [
      "curl",
      "-4",
      "-sS",
      "-o",
      "/tmp/smoke-r2-put-body.txt",
      "-w",
      "%{http_code}",
      "-X",
      "PUT",
      "-H",
      `Content-Type: ${intent.upload.headers["Content-Type"]}`,
      "--data-binary",
      `@${putFile}`,
      intent.upload.url,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const putStatusText = (await new Response(putProc.stdout).text()).trim();
  const putErr = (await new Response(putProc.stderr).text()).trim();
  const putStatus = Number(putStatusText);
  if (!Number.isFinite(putStatus) || putStatus < 200 || putStatus >= 300) {
    const body = await Bun.file("/tmp/smoke-r2-put-body.txt")
      .text()
      .catch(() => "");
    throw new Error(
      `Presigned PUT failed: ${putStatusText} ${putErr} ${body.slice(0, 300)}`,
    );
  }

  const confirmed = await media.confirm(
    identity,
    intent.asset.id,
    "smoke-confirm",
  );

  const publicUrl = confirmed.url as string | null;
  let publicGetStatus: number | null = null;
  let publicGetNote = "no url returned";
  if (publicUrl) {
    try {
      const res = await fetch(publicUrl, { method: "GET" });
      publicGetStatus = res.status;
      publicGetNote =
        res.status === 200
          ? "URL is publicly readable"
          : `Public GET returned ${res.status} (bucket/CDN may not be public)`;
    } catch (error) {
      publicGetNote = `Public GET failed: ${error instanceof Error ? error.name : "error"}`;
    }
  }

  const objectKey = await media.getObjectKeyForTests(intent.asset.id, cityId);

  console.log(
    JSON.stringify(
      {
        ok: confirmed.status === "READY",
        assetId: intent.asset.id,
        cityId,
        objectKey,
        publicUrl,
        publicGetStatus,
        publicGetNote,
        publicBaseUrlHost: (() => {
          try {
            return new URL(config.r2PublicBaseUrl).host;
          } catch {
            return null;
          }
        })(),
        putStatus,
      },
      null,
      2,
    ),
  );
};

try {
  await main();
} finally {
  await client.close();
}
