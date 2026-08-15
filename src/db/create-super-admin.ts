import { SQL } from "bun";
import { ConfigurationError, loadDatabaseConfig } from "../config/env";
import { AppError } from "../errors/app-error";
import { normalizeEmail } from "../modules/auth/shared/normalization";
import { Argon2PasswordHasher } from "../modules/auth/staff/password";
import { createDatabaseClient } from "./client";

export class SuperAdminBootstrapError extends Error {
  override readonly name = "SuperAdminBootstrapError";
}

export interface SuperAdminBootstrapInput {
  email: string;
  password: string;
  update: boolean;
}

export function parseSuperAdminArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): SuperAdminBootstrapInput {
  let email = env.SUPER_ADMIN_EMAIL;
  let password = env.SUPER_ADMIN_PASSWORD;
  let update = env.SUPER_ADMIN_UPDATE === "1" || env.SUPER_ADMIN_UPDATE === "true";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--email") email = argv[++index];
    else if (flag === "--password") password = argv[++index];
    else if (flag === "--update") update = true;
  }
  if (!email?.trim() || !password) {
    throw new SuperAdminBootstrapError(
      "Provide --email and --password (or SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD)",
    );
  }
  if (password.length < 12 || password.length > 128) {
    throw new SuperAdminBootstrapError("Password must be 12–128 characters");
  }
  return { email, password, update };
}

export async function createSuperAdmin(
  client: SQL,
  hasher: Argon2PasswordHasher,
  input: SuperAdminBootstrapInput,
): Promise<{ accountId: string; created: boolean }> {
  const email = normalizeEmail(input.email);
  const hash = await hasher.hash(input.password);
  return client.begin(async (tx) => {
    const [existing] = await tx<
      { account_id: string }[]
    >`select account_id from account_emails where email_normalized=${email}`;
    if (existing) {
      if (!input.update) {
        throw new SuperAdminBootstrapError(
          "Email already used. Pass --update to reset the password and ensure SUPER_ADMIN.",
        );
      }
      await tx`update accounts set status='ACTIVE',updated_at=now() where id=${existing.account_id}`;
      await tx`update staff_profiles set status='ACTIVE',managed_by_account_id=null,updated_at=now() where account_id=${existing.account_id}`;
      await tx`update password_credentials set argon2id_hash=${hash},password_changed_at=now(),updated_at=now() where account_id=${existing.account_id}`;
      await ensureSuperAdminRole(tx, existing.account_id);
      return { accountId: existing.account_id, created: false };
    }
    const [account] = await tx<{ id: string }[]>`insert into accounts default values returning id`;
    const accountId = account!.id;
    await tx`insert into account_emails(account_id,email_original,email_normalized,verified_at,is_primary)values(${accountId},${email},${email},now(),true)`;
    await tx`insert into staff_profiles(account_id,status,display_name,managed_by_account_id)values(${accountId},'ACTIVE','Super Admin',null)`;
    await tx`insert into password_credentials(account_id,argon2id_hash)values(${accountId},${hash})`;
    await ensureSuperAdminRole(tx, accountId);
    return { accountId, created: true };
  });
}

async function ensureSuperAdminRole(tx: SQL, accountId: string): Promise<void> {
  const [role] = await tx<
    { id: string }[]
  >`select id from roles where code='SUPER_ADMIN'::staff_role_code and status='ACTIVE'`;
  if (!role) throw new SuperAdminBootstrapError("SUPER_ADMIN role is not seeded");
  let [assignment] = await tx<
    { id: string }[]
  >`select id from account_roles where account_id=${accountId} and role_id=${role.id} and revoked_at is null`;
  if (!assignment) {
    const [inserted] = await tx<
      { id: string }[]
    >`insert into account_roles(account_id,role_id,granted_by_account_id,reason)values(${accountId},${role.id},${accountId},'BOOTSTRAP_SUPER_ADMIN') returning id`;
    assignment = inserted;
  }
  const [scope] = await tx<
    { id: string }[]
  >`select id from account_role_scopes where account_role_id=${assignment!.id} and scope_type='GLOBAL'`;
  if (!scope) {
    await tx`insert into account_role_scopes(account_role_id,scope_type,scope_reference_id,created_by_account_id)values(${assignment!.id},'GLOBAL',null,${accountId})`;
  }
}

function argon2FromEnv(env: Record<string, string | undefined>) {
  const integer = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${name} must be an integer`);
    return Number(raw);
  };
  return new Argon2PasswordHasher({
    memoryCost: integer("ARGON2_MEMORY_COST", 65_536),
    timeCost: integer("ARGON2_TIME_COST", 3),
    parallelism: integer("ARGON2_PARALLELISM", 1),
  });
}

if (import.meta.main) {
  const input = parseSuperAdminArgs(process.argv.slice(2));
  const config = loadDatabaseConfig();
  const database = createDatabaseClient(config);
  try {
    const result = await createSuperAdmin(database.client, argon2FromEnv(process.env), input);
    console.log(
      JSON.stringify({
        level: "info",
        event: result.created ? "super_admin_created" : "super_admin_updated",
        account_id: result.accountId,
        email: normalizeEmail(input.email),
      }),
    );
  } catch (error) {
    const message =
      error instanceof SuperAdminBootstrapError || error instanceof AppError || error instanceof ConfigurationError
        ? error.message
        : "Failed to create Super Admin";
    console.error(JSON.stringify({ level: "error", event: "super_admin_failed", message }));
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
