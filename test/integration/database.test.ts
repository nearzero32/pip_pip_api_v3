import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createApp } from "../../src/app";
import { applyMigrations } from "../../src/db/migration-runner";
import { silentLogger } from "../../src/observability/logger";

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;

function validateTestAdminUrl(raw: string | undefined): string {
  if (!raw) throw new Error("TEST_ADMIN_DATABASE_URL is required for integration tests");
  const url = new URL(raw);
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) throw new Error("TEST_ADMIN_DATABASE_URL must be PostgreSQL");
  if (!["localhost", "127.0.0.1", "db"].includes(url.hostname)) throw new Error("Integration tests may only use a local or Compose PostgreSQL host");
  if (/prod|production/i.test(url.pathname)) throw new Error("Integration tests refuse production-looking database names");
  return raw;
}

const validatedAdminUrl = validateTestAdminUrl(adminUrl);

async function expectDatabaseRejection(operation: PromiseLike<unknown>): Promise<void> {
  let rejected = false;
  try {
    await operation;
  } catch (error) {
    rejected = true;
    expect(error).toBeInstanceOf(Error);
  }
  expect(rejected).toBeTrue();
}

async function applySqlFile(client: SQL, path: string): Promise<void> {
  const sql = await Bun.file(path).text();
  for (const statement of sql.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) {
    await client.unsafe(statement);
  }
}

describe("PostgreSQL identity foundation", () => {
  const databaseName = `pip_pip_v3_test_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: SQL;
  let client: SQL;

  beforeAll(async () => {
    admin = new SQL(validatedAdminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(validatedAdminUrl);
    url.pathname = `/${databaseName}`;
    client = new SQL(url.toString(), { max: 5 });
    await applyMigrations(client);
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.close();
    }
  });

  test("applies the complete migration set and seeds staff role identities only", async () => {
    const tables = await client<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;
    expect(tables.map((row) => row.table_name)).toContain("accounts");
    expect(tables.map((row) => row.table_name)).toContain("audit_logs");
    const roles = await client<{ code: string }[]>`select code::text as code from roles order by code`;
    expect(roles.map((row) => row.code).sort()).toEqual(["ACCOUNTANT", "ADMIN", "OPERATIONS", "SUPER_ADMIN", "SUPPORT"]);
    expect(Number((await client<{ count: string }[]>`select count(*)::text as count from permissions`)[0]?.count)).toBe(4);
    const permissionCodes = await client<{ code: string }[]>`select code from permissions order by code`;
    expect(permissionCodes.map((row) => row.code)).toEqual([
      "zones.archive",
      "zones.create",
      "zones.read",
      "zones.update",
    ]);
  });

  test("readiness succeeds against the migrated database", async () => {
    const app = createApp({ logger: silentLogger, production: false, readinessCheck: async () => { await client`select 1`; } });
    const response = await app.handle(new Request("http://localhost/health/ready"));
    expect(response.status).toBe(200);
  });

  test("enforces normalized phone and email uniqueness", async () => {
    const [first, second] = await client<{ id: string }[]>`
      insert into accounts (status)
      select 'ACTIVE'::account_status from generate_series(1, 2)
      returning id
    `;
    await client`insert into account_phones (account_id, phone_e164) values (${first!.id}, '+9647700000000')`;
    await expectDatabaseRejection(client`insert into account_phones (account_id, phone_e164) values (${second!.id}, '+9647700000000')`);
    await client`insert into account_emails (account_id, email_original, email_normalized) values (${first!.id}, 'Staff@Example.com', 'staff@example.com')`;
    await expectDatabaseRejection(client`insert into account_emails (account_id, email_original, email_normalized) values (${second!.id}, 'staff@example.com', 'staff@example.com')`);
  });

  test("one account accepts distinct customer and driver profiles but not duplicate profile types", async () => {
    const [owner] = await client<{ id: string }[]>`insert into accounts default values returning id`;
    const [reviewer] = await client<{ id: string }[]>`insert into accounts default values returning id`;
    const [application] = await client<{ id: string }[]>`
      insert into driver_applications (account_id, status, decided_at, decided_by_account_id)
      values (${owner!.id}, 'APPROVED', now(), ${reviewer!.id}) returning id
    `;
    await client`insert into customer_profiles (account_id) values (${owner!.id})`;
    await client`insert into driver_profiles (account_id, approved_application_id) values (${owner!.id}, ${application!.id})`;
    await expectDatabaseRejection(client`insert into customer_profiles (account_id) values (${owner!.id})`);
    await expectDatabaseRejection(client`insert into driver_profiles (account_id, approved_application_id) values (${owner!.id}, ${application!.id})`);
  });

  test("enforces driver document slots and evidenced type/side combinations", async () => {
    const [owner] = await client<{ id: string }[]>`insert into accounts default values returning id`;
    const [application] = await client<{ id: string }[]>`insert into driver_applications (account_id) values (${owner!.id}) returning id`;
    await client`insert into driver_application_documents
      (driver_application_id, application_version, document_type, side, object_key, uploaded_by_account_id)
      values (${application!.id}, 1, 'NATIONAL_ID', 'FRONT', 'driver-documents/one', ${owner!.id})`;
    await expectDatabaseRejection(client`insert into driver_application_documents
      (driver_application_id, application_version, document_type, side, object_key, uploaded_by_account_id)
      values (${application!.id}, 1, 'NATIONAL_ID', 'FRONT', 'driver-documents/two', ${owner!.id})`);
    await expectDatabaseRejection(client`insert into driver_application_documents
      (driver_application_id, application_version, document_type, side, object_key, uploaded_by_account_id)
      values (${application!.id}, 1, 'CONTRACT', 'FRONT', 'driver-documents/invalid', ${owner!.id})`);
  });

  test("important foreign keys prevent orphan identity records", async () => {
    const missing = crypto.randomUUID();
    await expectDatabaseRejection(client`insert into customer_profiles (account_id) values (${missing})`);
    await expectDatabaseRejection(client`insert into driver_applications (account_id) values (${missing})`);
  });

  test("enforces every invalid driver document type and side combination", async () => {
    const [owner] = await client<{ id: string }[]>`insert into accounts default values returning id`;
    const [application] = await client<{ id: string }[]>`insert into driver_applications (account_id) values (${owner!.id}) returning id`;
    for (const [type, side] of [["CONTRACT", "FRONT"], ["NATIONAL_ID", "SINGLE"], ["RESIDENCE_CARD", "SINGLE"]] as const) {
      await expectDatabaseRejection(client.unsafe(
        "insert into driver_application_documents (driver_application_id, application_version, document_type, side, object_key, uploaded_by_account_id) values ($1, 1, $2, $3, $4, $5)",
        [application!.id, type, side, `driver-documents/invalid-${type}-${side}`, owner!.id],
      ));
    }
  });

  test("enforces invitation, refresh replacement, OTP replacement, and password credential foreign keys", async () => {
    const missing = crypto.randomUUID();
    const [account] = await client<{ id: string }[]>`insert into accounts default values returning id`;
    await expectDatabaseRejection(client`insert into staff_profiles (account_id, invited_by_staff_id) values (${account!.id}, ${missing})`);
    await expectDatabaseRejection(client`insert into password_reset_tokens (account_id, password_credential_id, token_verifier, expires_at) values (${account!.id}, ${missing}, 'reset-verifier', now() + interval '15 minutes')`);
    await expectDatabaseRejection(client`insert into otp_challenges (purpose, application_type, phone_e164, otp_keyed_verifier, verifier_key_version, expires_at, resend_available_at, replacement_challenge_id) values ('LOGIN', 'CUSTOMER_APP', '+9647700000001', 'otp-verifier', 'v1', now() + interval '5 minutes', now() + interval '60 seconds', ${missing})`);
    const [session] = await client<{ id: string }[]>`insert into sessions (account_id, application_type, authentication_method, device_name, absolute_expires_at) values (${account!.id}, 'CUSTOMER_APP', 'PHONE_OTP', 'test device', now() + interval '1 day') returning id`;
    await expectDatabaseRejection(client`insert into session_refresh_tokens (session_id, generation, token_verifier, rotated_at, replaced_by_id) values (${session!.id}, 0, 'refresh-verifier', now(), ${missing})`);
  });

  test("identity history does not cascade when an account deletion is attempted", async () => {
    const [account] = await client<{ id: string }[]>`insert into accounts default values returning id`;
    await client`insert into customer_profiles (account_id) values (${account!.id})`;
    await expectDatabaseRejection(client`delete from accounts where id = ${account!.id}`);
    expect(Number((await client<{ count: string }[]>`select count(*)::text as count from customer_profiles where account_id = ${account!.id}`)[0]!.count)).toBe(1);
  });

  test("stores constrained textual API request IDs in audit logs", async () => {
    const requestId = "edge-gateway:request_2026.08.02";
    await client`insert into audit_logs (event_type, outcome, request_correlation_id) values ('TEST_EVENT', 'SUCCESS', ${requestId})`;
    expect((await client<{ request_id: string }[]>`select request_correlation_id as request_id from audit_logs where request_correlation_id = ${requestId}`)[0]?.request_id).toBe(requestId);
    await expectDatabaseRejection(client`insert into audit_logs (event_type, outcome, request_correlation_id) values ('TEST_EVENT', 'SUCCESS', 'unsafe request id')`);
  });

  test("upgrades an M1 database and converts legacy Dashboard authentication rows", async () => {
    const upgradeName = `pip_pip_v3_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${upgradeName}"`);
    const upgradeUrl = new URL(validatedAdminUrl); upgradeUrl.pathname = `/${upgradeName}`;
    const upgrade = new SQL(upgradeUrl.toString(), { max: 2 });
    try {
      for (const migration of ["0000_free_glorian", "0001_eager_revanche", "0002_late_micromax", "0003_uneven_king_cobra"]) await applySqlFile(upgrade, `./drizzle/${migration}.sql`);
      const [account] = await upgrade<{id:string}[]>`insert into accounts default values returning id`;
      await upgrade`insert into sessions(account_id,application_type,authentication_method,device_name,absolute_expires_at) values(${account!.id},'DASHBOARD','PASSWORD_TOTP','legacy dashboard',now()+interval '1 day')`;
      await applySqlFile(upgrade, "./drizzle/0004_supreme_cardiac.sql");
      await applySqlFile(upgrade, "./drizzle/0005_m2_auth_foundation.sql");
      await applySqlFile(upgrade, "./drizzle/0006_square_gertrude_yorkes.sql");
      await applySqlFile(upgrade, "./drizzle/0007_driver_access_code_foundation.sql");
      const [row] = await upgrade<{authentication_method:string}[]>`select authentication_method::text authentication_method from sessions`;
      expect(row!.authentication_method).toBe("PASSWORD");
      await expectDatabaseRejection(upgrade`insert into sessions(account_id,application_type,authentication_method,device_name,absolute_expires_at) values(${account!.id},'DASHBOARD','PASSWORD_TOTP','invalid',now()+interval '1 day')`);
      const [column]=await upgrade<{is_nullable:string}[]>`select is_nullable from information_schema.columns where table_name='driver_profiles' and column_name='access_code_hash'`;
      expect(column!.is_nullable).toBe("YES");
      await expectDatabaseRejection(upgrade`insert into sessions(account_id,application_type,authentication_method,device_name,absolute_expires_at) values(${account!.id},'DRIVER_APP','PHONE_OTP','invalid driver auth',now()+interval '1 day')`);
    } finally {
      await upgrade.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${upgradeName}" WITH (FORCE)`);
    }
  }, 30_000);
});
