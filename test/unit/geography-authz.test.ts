import { describe, expect, test } from "bun:test";
import {
  CITY_GOVERNORATE_FK_CONSTRAINT,
  isCityGovernorateForeignKeyViolation,
} from "../../src/modules/geography/city/city.service";

const referencesRoleTables = (sql: string): boolean => {
  const normalized = sql
    .toLowerCase()
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /(?:^|[\s,(])(?:only\s+)?(?:public\.)?(?:account_roles|roles)(?:\s|\)|,|$)/.test(
    normalized,
  );
};

describe("geography FK mapping", () => {
  test("maps only the City→Governorate constraint", () => {
    expect(
      isCityGovernorateForeignKeyViolation({
        errno: "23503",
        constraint: CITY_GOVERNORATE_FK_CONSTRAINT,
      }),
    ).toBeTrue();
    expect(
      isCityGovernorateForeignKeyViolation({
        code: "23503",
        constraint: CITY_GOVERNORATE_FK_CONSTRAINT,
      }),
    ).toBeTrue();
    expect(
      isCityGovernorateForeignKeyViolation({
        code: "ERR_POSTGRES_SERVER_ERROR",
        cause: {
          errno: "23503",
          constraint: CITY_GOVERNORATE_FK_CONSTRAINT,
        },
      }),
    ).toBeTrue();
    expect(
      isCityGovernorateForeignKeyViolation({
        errno: "23503",
        constraint: "account_emails_account_id_accounts_id_fk",
      }),
    ).toBeFalse();
    expect(
      isCityGovernorateForeignKeyViolation({
        errno: "23505",
        constraint: CITY_GOVERNORATE_FK_CONSTRAINT,
      }),
    ).toBeFalse();
  });
});

describe("role-table SQL detection", () => {
  test("detects table references without false positives", () => {
    expect(
      referencesRoleTables(
        "select r.code from account_roles ar join roles r on r.id=ar.role_id",
      ),
    ).toBeTrue();
    expect(
      referencesRoleTables(
        "update account_roles set revoked_at=now() where account_id=$1",
      ),
    ).toBeTrue();
    expect(
      referencesRoleTables(
        "select id,name_ar,name_en,status,display_order from governorates",
      ),
    ).toBeFalse();
    expect(
      referencesRoleTables(
        "select s.* from sessions s join accounts a on a.id=s.account_id",
      ),
    ).toBeFalse();
    expect(
      referencesRoleTables(
        "select 1 from staff_profiles where account_id=$1 and status='ACTIVE'",
      ),
    ).toBeFalse();
  });
});
