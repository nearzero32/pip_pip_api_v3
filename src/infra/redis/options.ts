import { RedisClient, type RedisOptions } from "bun";

/**
 * Bun Redis `idleTimeout` is milliseconds. `0` disables idle disconnect.
 * A previous value of `30` was misread as seconds and closed connections after 30ms.
 */
export const REDIS_IDLE_TIMEOUT_MS = 0;

export const LONG_LIVED_REDIS_OPTIONS: RedisOptions = {
  connectionTimeout: 3000,
  idleTimeout: REDIS_IDLE_TIMEOUT_MS,
  autoReconnect: true,
  maxRetries: 20,
  enableOfflineQueue: true,
};

/**
 * Fail closed for auth rate limiting: do not queue commands while disconnected.
 * Bun Redis is lazy; RedisRateLimiter calls connect() before the first command.
 * Subsequent requests still reconnect via `autoReconnect`.
 */
export const RATE_LIMITER_REDIS_OPTIONS: RedisOptions = {
  connectionTimeout: 3000,
  idleTimeout: REDIS_IDLE_TIMEOUT_MS,
  autoReconnect: true,
  maxRetries: 20,
  enableOfflineQueue: false,
};

export function createLongLivedRedisClient(url: string): RedisClient {
  return new RedisClient(url, LONG_LIVED_REDIS_OPTIONS);
}

export function createRateLimiterRedisClient(url: string): RedisClient {
  return new RedisClient(url, RATE_LIMITER_REDIS_OPTIONS);
}
