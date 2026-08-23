import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";

import { AppError } from "../../src/errors/app-error";
import { DriverManagementService } from "../../src/modules/auth/mobile/driver/driver-management.service";
import type { AuthIdentity } from "../../src/modules/auth/sessions/session-service";
import type { Argon2PasswordHasher } from "../../src/modules/auth/staff/password";

const noDatabase = new Proxy(() => undefined, {
  apply() {
    throw new Error("database must not be called");
  },
}) as unknown as SQL;

const noHash = {
  hash: async () => {
    throw new Error("password hasher must not be called");
  },
} as unknown as Argon2PasswordHasher;

const superAdmin: AuthIdentity = {
  accountId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  applicationType: "DASHBOARD",
  roles: ["SUPER_ADMIN"],
  scopeType: "GLOBAL",
  cityId: null,
  storeId: null,
};

describe("driver management validation and authorization", () => {
  const service = new DriverManagementService(noDatabase, noHash);

  test("blocks City ADMIN before querying the database", async () => {
    const cityAdmin: AuthIdentity = {
      ...superAdmin,
      roles: ["ADMIN"],
      scopeType: "CITY",
      cityId: "33333333-3333-4333-8333-333333333333",
    };
    await expect(service.list(cityAdmin)).rejects.toMatchObject({
      statusCode: 403,
      publicCode: "FORBIDDEN",
    } satisfies Partial<AppError>);
  });

  test("rejects a non-numeric access code before database or hashing work", async () => {
    await expect(
      service.create(superAdmin, {
        phone: "+9647701234567",
        accessCode: "secret",
        cityId: "33333333-3333-4333-8333-333333333333",
        driverPhotoAssetId: "44444444-4444-4444-8444-444444444444",
        driverName: "Driver", fatherName: "Father", motherName: "Mother", alternatePhone: "+9647701234568",
        nationalIdFrontAssetId: "55555555-5555-4555-8555-555555555555", nationalIdBackAssetId: "66666666-6666-4666-8666-666666666666",
        residenceCardFrontAssetId: "77777777-7777-4777-8777-777777777777", residenceCardBackAssetId: "88888888-8888-4888-8888-888888888888", contractAssetId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      publicCode: "VALIDATION_FAILED",
    } satisfies Partial<AppError>);
  });

  test("rejects an invalid access-code reset before hashing", async () => {
    await expect(
      service.resetAccessCode(superAdmin, superAdmin.accountId, "12ab56"),
    ).rejects.toMatchObject({
      statusCode: 422,
      publicCode: "VALIDATION_FAILED",
    } satisfies Partial<AppError>);
  });
});
