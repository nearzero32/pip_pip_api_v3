import { describe, expect, test } from "bun:test";
import { RateLimiterUnavailableError } from "../../src/errors/rate-limiter-unavailable-error";
import { DashboardAuthService } from "../../src/modules/auth/dashboard/dashboard-auth.service";
import { CustomerAuthService } from "../../src/modules/auth/mobile/customer/customer-auth.service";
import { DriverAuthService } from "../../src/modules/auth/mobile/driver/driver-auth.service";
import { MerchantAuthService } from "../../src/modules/auth/merchant/merchant-auth.service";
import type { RateLimiter } from "../../src/modules/auth/rate-limit/rate-limiter";
import { HmacSecretVerifier } from "../../src/modules/auth/shared/secret-verifier";
import { Argon2PasswordHasher } from "../../src/modules/auth/staff/password";
import { SessionService } from "../../src/modules/auth/sessions/session-service";
import { dashboardContext } from "../../src/modules/auth/core/context";

const unavailable: RateLimiter = {
  consume: async () => {
    throw new RateLimiterUnavailableError("consume", "CONNECTION_CLOSED");
  },
  reset: async () => undefined,
};

const verifier = new HmacSecretVerifier("v1", "test-verifier-key-that-is-at-least-32-characters");
const password = new Argon2PasswordHasher({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
const audit = { write: async () => undefined };
let sqlCalls = 0;
const client = new Proxy(
  {},
  {
    get: () => {
      sqlCalls++;
      throw new Error("sql must not run after limiter failure");
    },
  },
) as never;
const sessions = {
  create: async () => {
    throw new Error("session must not be created");
  },
  result: async () => {
    throw new Error("token must not be issued");
  },
  refresh: async () => {
    throw new Error("refresh must not rotate");
  },
} as unknown as SessionService;

describe("auth fail-closed when the rate limiter is unavailable", () => {
  test("dashboard login does not look up credentials or issue a session", async () => {
    sqlCalls = 0;
    const service = new DashboardAuthService(client, unavailable, password, verifier, sessions, audit as never);
    await expect(
      service.login({
        email: "staff@example.com",
        password: "a sufficiently long password",
        deviceName: "browser",
        ip: "127.0.0.1",
        requestId: "login-outage",
      }),
    ).rejects.toMatchObject({ publicCode: "RATE_LIMITER_UNAVAILABLE", statusCode: 503 });
    expect(sqlCalls).toBe(0);
  });

  test("refresh does not rotate tokens", async () => {
    const service = new SessionService(client, unavailable, verifier, {} as never, audit as never);
    await expect(
      service.refresh("a".repeat(43), dashboardContext, "127.0.0.1", "refresh-outage"),
    ).rejects.toMatchObject({ publicCode: "RATE_LIMITER_UNAVAILABLE", statusCode: 503 });
  });

  test("customer, driver, and merchant auth fail the same way", async () => {
    const customer = new CustomerAuthService(client, unavailable, { deliver: async () => undefined }, verifier, sessions, audit as never);
    const driver = new DriverAuthService(client, unavailable, password, verifier, sessions, audit as never);
    const merchant = new MerchantAuthService(client, unavailable, password, verifier, sessions, audit as never);
    await expect(
      customer.requestOtp({ phone: "+9647700000000", ip: "127.0.0.1", requestId: "otp-outage" }),
    ).rejects.toMatchObject({ publicCode: "RATE_LIMITER_UNAVAILABLE" });
    await expect(
      driver.login({
        phone: "+9647700000000",
        code: "123456",
        deviceName: "phone",
        ip: "127.0.0.1",
        requestId: "driver-outage",
      }),
    ).rejects.toMatchObject({ publicCode: "RATE_LIMITER_UNAVAILABLE" });
    await expect(
      merchant.login({
        phone: "+9647700000000",
        password: "a sufficiently long password",
        deviceName: "phone",
        ip: "127.0.0.1",
        requestId: "merchant-outage",
      }),
    ).rejects.toMatchObject({ publicCode: "RATE_LIMITER_UNAVAILABLE" });
  });
});
