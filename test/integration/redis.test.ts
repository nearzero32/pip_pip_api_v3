import { afterAll, describe, expect, test } from "bun:test";
import { RedisRateLimiter } from "../../src/modules/auth/rate-limit/redis-rate-limiter";

const redisUrl=process.env.TEST_REDIS_URL;
if(!redisUrl)throw new Error("TEST_REDIS_URL is required for Redis integration tests");
const url=new URL(redisUrl);if(!["localhost","127.0.0.1"].includes(url.hostname))throw new Error("Unsafe integration Redis host");
const limiter=new RedisRateLimiter(redisUrl);
describe("Redis rate limiter",()=>{
  afterAll(async()=>limiter.close());
  test("atomically increments and applies TTL",async()=>{const key=`auth:test:${crypto.randomUUID()}`;const results=await Promise.all(Array.from({length:5},()=>limiter.consume(key,{limit:3,windowSeconds:10})));expect(results.filter(x=>x.allowed).length).toBe(3);expect(results.every(x=>x.retryAfterSeconds>0&&x.retryAfterSeconds<=10)).toBeTrue();await limiter.reset(key);expect((await limiter.consume(key,{limit:3,windowSeconds:10})).remaining).toBe(2);});
});
