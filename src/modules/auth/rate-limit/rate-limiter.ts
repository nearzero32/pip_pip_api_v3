export interface RateLimitPolicy { limit: number; windowSeconds: number }
export interface RateLimitResult { allowed: boolean; remaining: number; retryAfterSeconds: number }
export interface RateLimiter { consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult>; reset(key: string): Promise<void> }

export class InMemoryRateLimiter implements RateLimiter {
  private values = new Map<string, { count: number; expiresAt: number }>();
  constructor(private now: () => number = Date.now) {}
  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult> {
    const now = this.now(); let value = this.values.get(key);
    if (!value || value.expiresAt <= now) { value = { count: 0, expiresAt: now + policy.windowSeconds * 1000 }; this.values.set(key, value); }
    value.count++;
    return { allowed: value.count <= policy.limit, remaining: Math.max(0, policy.limit - value.count), retryAfterSeconds: Math.max(1, Math.ceil((value.expiresAt - now) / 1000)) };
  }
  async reset(key: string): Promise<void> { this.values.delete(key); }
}

export const rateLimitKey = (...parts: string[]): string => `auth:${parts.map((part) => encodeURIComponent(part)).join(":")}`;
