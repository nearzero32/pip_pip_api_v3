import { afterAll, describe, expect, test } from "bun:test";
import { RateLimiterUnavailableError } from "../../src/errors/rate-limiter-unavailable-error";
import { RedisRateLimiter } from "../../src/modules/auth/rate-limit/redis-rate-limiter";

const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl) throw new Error("TEST_REDIS_URL is required for Redis integration tests");
const url = new URL(redisUrl);
if (!["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error("Unsafe integration Redis host");
const limiter = new RedisRateLimiter(redisUrl);

describe("Redis rate limiter", () => {
  afterAll(async () => limiter.close());

  test("atomically increments and applies TTL", async () => {
    const key = `auth:test:${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => limiter.consume(key, { limit: 3, windowSeconds: 10 })),
    );
    expect(results.filter((x) => x.allowed).length).toBe(3);
    expect(results.every((x) => x.retryAfterSeconds > 0 && x.retryAfterSeconds <= 10)).toBeTrue();
    await limiter.reset(key);
    expect((await limiter.consume(key, { limit: 3, windowSeconds: 10 })).remaining).toBe(2);
  });

  test("survives idle longer than the old 30ms disconnect", async () => {
    const key = `auth:idle:${crypto.randomUUID()}`;
    expect((await limiter.consume(key, { limit: 5, windowSeconds: 30 })).allowed).toBeTrue();
    await Bun.sleep(80);
    const second = await limiter.consume(key, { limit: 5, windowSeconds: 30 });
    expect(second.allowed).toBeTrue();
    expect(second.remaining).toBe(3);
  });

  test("healthCheck pings without changing counters", async () => {
    const key = `auth:health:${crypto.randomUUID()}`;
    const before = await limiter.consume(key, { limit: 5, windowSeconds: 30 });
    await limiter.healthCheck();
    const after = await limiter.consume(key, { limit: 5, windowSeconds: 30 });
    expect(after.remaining).toBe(before.remaining - 1);
  });

  test("maps a disconnected injectable client to 503 without bypassing the limiter", async () => {
    const fake = {
      evals: 0,
      async send() {
        this.evals++;
        const error = new Error("Connection closed");
        error.name = "RedisError";
        throw error;
      },
      async del() {
        return 0;
      },
      async ping() {
        const error = new Error("Connection closed");
        error.name = "RedisError";
        throw error;
      },
      close() {},
    };
    const broken = new RedisRateLimiter(redisUrl, { client: fake });
    await expect(broken.consume("auth:outage", { limit: 3, windowSeconds: 10 })).rejects.toBeInstanceOf(
      RateLimiterUnavailableError,
    );
    expect(fake.evals).toBe(1);
    await expect(broken.healthCheck()).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });

  test("recovers after a controllable client outage without recreating the limiter", async () => {
    let down = true;
    const fake = {
      count: 0,
      async send(_command: string, _args: string[]) {
        if (down) {
          const error = new Error("Connection refused");
          error.name = "RedisError";
          throw error;
        }
        this.count += 1;
        return [this.count, 10];
      },
      async del() {
        return 1;
      },
      async ping() {
        if (down) {
          const error = new Error("Connection refused");
          error.name = "RedisError";
          throw error;
        }
        return "PONG";
      },
      close() {},
    };
    const recoverable = new RedisRateLimiter(redisUrl, { client: fake });
    await expect(recoverable.healthCheck()).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    await expect(recoverable.consume("k", { limit: 3, windowSeconds: 10 })).rejects.toBeInstanceOf(
      RateLimiterUnavailableError,
    );
    down = false;
    await recoverable.healthCheck();
    expect((await recoverable.consume("k", { limit: 3, windowSeconds: 10 })).allowed).toBeTrue();
  });
});
