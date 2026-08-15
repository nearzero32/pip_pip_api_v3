import { describe, expect, test } from "bun:test";
import { RateLimiterUnavailableError } from "../../src/errors/rate-limiter-unavailable-error";
import {
  LONG_LIVED_REDIS_OPTIONS,
  RATE_LIMITER_REDIS_OPTIONS,
  REDIS_IDLE_TIMEOUT_MS,
} from "../../src/infra/redis/options";
import {
  RedisRateLimiter,
  type RedisCommandClient,
} from "../../src/modules/auth/rate-limit/redis-rate-limiter";
import { createLogger, silentLogger } from "../../src/observability/logger";

class RedisNamedError extends Error {
  constructor(message: string, name = "RedisError") {
    super(message);
    this.name = name;
  }
}

class FakeRedisClient implements RedisCommandClient {
  commands: Array<{ command: string; args: string[] }> = [];
  closed = 0;
  failWith: unknown = null;
  response: unknown = [1, 10];
  pingResponse: unknown = "PONG";
  evalCalls = 0;

  async send(command: string, args: string[]) {
    this.commands.push({ command, args });
    if (command === "EVAL") this.evalCalls++;
    if (this.failWith) throw this.failWith;
    return this.response;
  }
  async del(key: string) {
    this.commands.push({ command: "DEL", args: [key] });
    if (this.failWith) throw this.failWith;
    return 1;
  }
  async ping() {
    this.commands.push({ command: "PING", args: [] });
    if (this.failWith) throw this.failWith;
    return this.pingResponse;
  }
  close() {
    this.closed++;
  }
}

describe("Redis client options", () => {
  test("idleTimeout is 0 milliseconds and reconnect is explicit", () => {
    expect(REDIS_IDLE_TIMEOUT_MS).toBe(0);
    expect(RATE_LIMITER_REDIS_OPTIONS.idleTimeout).toBe(0);
    expect(RATE_LIMITER_REDIS_OPTIONS.autoReconnect).toBeTrue();
    expect(RATE_LIMITER_REDIS_OPTIONS.maxRetries).toBe(20);
    expect(RATE_LIMITER_REDIS_OPTIONS.enableOfflineQueue).toBeFalse();
    expect(LONG_LIVED_REDIS_OPTIONS.idleTimeout).toBe(0);
    expect(LONG_LIVED_REDIS_OPTIONS.autoReconnect).toBeTrue();
    expect(LONG_LIVED_REDIS_OPTIONS.maxRetries).toBe(20);
    expect(LONG_LIVED_REDIS_OPTIONS.enableOfflineQueue).toBeTrue();
  });
});

describe("RedisRateLimiter", () => {
  test("maps connection failures and timeouts to dependency errors without retrying EVAL", async () => {
    for (const failure of [
      new RedisNamedError("Connection closed"),
      new RedisNamedError("connection timeout"),
      new RedisNamedError("ECONNREFUSED"),
    ]) {
      const client = new FakeRedisClient();
      client.failWith = failure;
      const limiter = new RedisRateLimiter("redis://user:secret@localhost:6379", {
        client,
        logger: silentLogger,
      });
      await expect(limiter.consume("k", { limit: 3, windowSeconds: 10 })).rejects.toBeInstanceOf(
        RateLimiterUnavailableError,
      );
      expect(client.evalCalls).toBe(1);
    }
  });

  test("does not hide Lua or unexpected response bugs as 503", async () => {
    const syntax = new FakeRedisClient();
    syntax.failWith = new RedisNamedError(
      "ERR Error compiling script (new function): user_script:1: syntax error",
    );
    const limiter = new RedisRateLimiter("redis://localhost:6379", { client: syntax });
    await expect(limiter.consume("k", { limit: 3, windowSeconds: 10 })).rejects.toMatchObject({
      name: "RedisError",
    });
    expect(syntax.evalCalls).toBe(1);

    const shape = new FakeRedisClient();
    shape.response = "OK";
    const shapeLimiter = new RedisRateLimiter("redis://localhost:6379", { client: shape });
    await expect(shapeLimiter.consume("k", { limit: 3, windowSeconds: 10 })).rejects.toThrow(
      "Unexpected rate limiter response",
    );
  });

  test("healthCheck uses PING and close is idempotent", async () => {
    const client = new FakeRedisClient();
    const limiter = new RedisRateLimiter("redis://localhost:6379", { client });
    await limiter.healthCheck();
    expect(client.commands).toEqual([{ command: "PING", args: [] }]);
    expect(client.evalCalls).toBe(0);
    await limiter.close();
    await limiter.close();
    expect(client.closed).toBe(1);
  });

  test("logs do not include Redis URL or credentials", () => {
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => lines.push(line));
    const client = new FakeRedisClient();
    const limiter = new RedisRateLimiter("redis://user:super-secret@localhost:6379/0", {
      client,
      logger,
    });
    logger.warn({
      event: "rate_limiter_unavailable",
      request_id: "req-1",
      operation: "consume",
      error_code: "CONNECTION_CLOSED",
    });
    expect(JSON.stringify(limiter)).not.toContain("super-secret");
    expect(lines.join("\n")).not.toContain("super-secret");
    expect(lines.join("\n")).not.toContain("redis://");
  });
});
