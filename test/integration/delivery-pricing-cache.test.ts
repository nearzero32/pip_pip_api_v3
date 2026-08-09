import { afterAll,beforeAll,describe,expect,test } from "bun:test";
import { ACTIVE_PRICING_CACHE_PREFIX,RedisActivePricingCache,type ActivePricing } from "../../src/modules/delivery-pricing/active-pricing-cache";

const cityId=crypto.randomUUID(),key=`${ACTIVE_PRICING_CACHE_PREFIX}${cityId}`;
let cache:RedisActivePricingCache;
const value=(revision:number):ActivePricing=>({cityId,pricingVersionId:crypto.randomUUID(),versionNumber:1,activationRevision:revision,status:"ACTIVE",activatedAt:new Date().toISOString(),routingProvider:"OSRM",routingTimeoutMs:3000,routingMaxAttempts:2,baseFee:1000,includedDistanceMeters:0,pricePerKm:500,roundingStep:250,maximumDeliveryDistanceMeters:null,routingFallbackEnabled:true,fallbackOnNoRoute:true,fallbackOnProviderFailure:true,fallbackExtraDistanceMeters:100,currency:"IQD"});

describe("Redis active pricing cache CAS",()=>{
  beforeAll(async()=>{cache=new RedisActivePricingCache(process.env.TEST_REDIS_URL??"redis://127.0.0.1:6380");await cache.client.del(key);});
  afterAll(async()=>{await cache.client.del(key);cache.close();});
  test("writes TTL and atomically rejects stale revision without extending TTL",async()=>{const newer=value(20),stale=value(19);expect(await cache.writeIfNewer(cityId,newer,21600)).toBeTrue();const ttlBefore=Number(await cache.client.send("TTL",[key]));expect(await cache.writeIfNewer(cityId,stale,86400)).toBeFalse();const ttlAfter=Number(await cache.client.send("TTL",[key]));expect(ttlAfter).toBeLessThanOrEqual(ttlBefore);expect(JSON.parse((await cache.get(cityId))!).activationRevision).toBe(20);expect(ttlAfter).toBeGreaterThan(21000);});
  test("corrupt entry is atomically replaced",async()=>{await cache.client.set(key,"corrupt");const fresh=value(21);expect(await cache.writeIfNewer(cityId,fresh,21600)).toBeTrue();expect(JSON.parse((await cache.get(cityId))!).activationRevision).toBe(21);});
});
