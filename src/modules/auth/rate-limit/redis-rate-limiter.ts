import { RedisClient } from "bun";
import { mapRedisRateLimiterFailure } from "../../../errors/rate-limiter-unavailable-error";
import { createRateLimiterRedisClient } from "../../../infra/redis/options";
import type { Logger } from "../../../observability/logger";
import type { RateLimiter, RateLimitPolicy, RateLimitResult } from "./rate-limiter";

const script = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; local ttl=redis.call('TTL',KEYS[1]); return {n,ttl}`;

export interface RedisCommandClient {
  send(command: string, args: string[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  ping(): Promise<unknown>;
  close(): void;
}

export class RedisRateLimiter implements RateLimiter {
  readonly client: RedisCommandClient;
  private closed = false;

  constructor(
    url: string,
    options: { client?: RedisCommandClient; logger?: Logger } = {},
  ) {
    this.client = options.client ?? createRateLimiterRedisClient(url);
    if (options.logger && this.client instanceof RedisClient) {
      this.client.onclose = (error) => {
        options.logger!.warn({
          event: "redis_disconnected",
          client: "rate_limiter",
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
      };
      this.client.onconnect = () => {
        options.logger!.info({
          event: "redis_reconnected",
          client: "rate_limiter",
        });
      };
    }
  }

  private async ensureConnected(operation: string): Promise<void> {
    if (!(this.client instanceof RedisClient) || this.client.connected) return;
    try {
      await this.client.connect();
    } catch (error) {
      mapRedisRateLimiterFailure(error, operation);
    }
  }

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    await this.ensureConnected("consume");
    let result: unknown;
    try {
      result = await this.client.send("EVAL", [
        script,
        "1",
        key,
        String(policy.windowSeconds),
      ]);
    } catch (error) {
      return mapRedisRateLimiterFailure(error, "consume");
    }
    if (
      !Array.isArray(result) ||
      result.length < 2 ||
      typeof result[0] !== "number" ||
      typeof result[1] !== "number"
    ) {
      throw new Error("Unexpected rate limiter response");
    }
    const count = result[0];
    const ttl = result[1];
    return {
      allowed: count <= policy.limit,
      remaining: Math.max(0, policy.limit - count),
      retryAfterSeconds: Math.max(1, ttl),
    };
  }

  async reset(key: string): Promise<void> {
    await this.ensureConnected("reset");
    try {
      await this.client.del(key);
    } catch (error) {
      return mapRedisRateLimiterFailure(error, "reset");
    }
  }

  async healthCheck(): Promise<void> {
    await this.ensureConnected("healthCheck");
    let result: unknown;
    try {
      result = await this.client.ping();
    } catch (error) {
      return mapRedisRateLimiterFailure(error, "healthCheck");
    }
    if (String(result).toUpperCase() !== "PONG") {
      throw new Error("Unexpected rate limiter health response");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
  }
}
