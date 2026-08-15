import { describe, expect, test } from "bun:test";
import {
  parseSuperAdminArgs,
  SuperAdminBootstrapError,
} from "../../src/db/create-super-admin";

describe("create Super Admin CLI", () => {
  test("reads flags", () => {
    expect(
      parseSuperAdminArgs(["--email", "Super@Example.com", "--password", "fixed staff password"], {}),
    ).toEqual({
      email: "Super@Example.com",
      password: "fixed staff password",
      update: false,
    });
  });

  test("reads environment and --update", () => {
    expect(
      parseSuperAdminArgs(["--update"], {
        SUPER_ADMIN_EMAIL: "super@example.com",
        SUPER_ADMIN_PASSWORD: "fixed staff password",
      }),
    ).toEqual({
      email: "super@example.com",
      password: "fixed staff password",
      update: true,
    });
  });

  test("rejects a short password and missing credentials", () => {
    expect(() => parseSuperAdminArgs([], {})).toThrow(SuperAdminBootstrapError);
    expect(() =>
      parseSuperAdminArgs(["--email", "super@example.com", "--password", "short"], {}),
    ).toThrow(SuperAdminBootstrapError);
  });
});
