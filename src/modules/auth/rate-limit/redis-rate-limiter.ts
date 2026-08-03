import { RedisClient } from "bun";
import type { RateLimiter, RateLimitPolicy, RateLimitResult } from "./rate-limiter";

const script = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; local ttl=redis.call('TTL',KEYS[1]); return {n,ttl}`;
export class RedisRateLimiter implements RateLimiter {
  readonly client: RedisClient;
  constructor(url: string) { this.client = new RedisClient(url, { connectionTimeout: 3000, idleTimeout: 30 }); }
  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const result = await this.client.send("EVAL", [script, "1", key, String(policy.windowSeconds)]) as [number, number];
    return { allowed: result[0] <= policy.limit, remaining: Math.max(0, policy.limit - result[0]), retryAfterSeconds: Math.max(1, result[1]) };
  }
  async reset(key: string): Promise<void> { await this.client.del(key); }
  async close(): Promise<void> { this.client.close(); }
}
