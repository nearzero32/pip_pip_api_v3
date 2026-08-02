import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createApp } from "../../src/app";
import { silentLogger } from "../../src/observability/logger";

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
const run = adminUrl ? describe : describe.skip;

async function expectDatabaseRejection(operation: PromiseLike<unknown>): Promise<void> {
  try {
    await operation;
    throw new Error("Expected PostgreSQL to reject the operation");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
  }
}

run("PostgreSQL identity foundation", () => {
  const databaseName = `pip_pip_v3_test_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: SQL;
  let client: SQL;

  beforeAll(async () => {
    if (!adminUrl) throw new Error("TEST_ADMIN_DATABASE_URL or DATABASE_URL is required");
    admin = new SQL(adminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    client = new SQL(url.toString(), { max: 5 });
    await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
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
    expect(Number((await client<{ count: string }[]>`select count(*)::text as count from permissions`)[0]?.count)).toBe(0);
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
});
