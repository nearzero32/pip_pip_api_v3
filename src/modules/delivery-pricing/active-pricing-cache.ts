import { RedisClient } from "bun";

export const ACTIVE_PRICING_CACHE_PREFIX = "delivery-pricing:active:v1:";

export type ActivePricing = {
  cityId: string;
  pricingVersionId: string;
  versionNumber: number;
  activationRevision: number;
  status: "ACTIVE";
  activatedAt: string;
  routingProvider: "OSRM";
  routingTimeoutMs: number;
  routingMaxAttempts: 2;
  baseFee: number;
  includedDistanceMeters: number;
  pricePerKm: number;
  roundingStep: number;
  maximumDeliveryDistanceMeters: number | null;
  routingFallbackEnabled: boolean;
  fallbackOnNoRoute: boolean;
  fallbackOnProviderFailure: boolean;
  fallbackExtraDistanceMeters: number;
  currency: "IQD";
};

export interface ActivePricingCache {
  get(cityId: string): Promise<string | null>;
  writeIfNewer(cityId: string, value: ActivePricing, ttlSeconds: number): Promise<boolean>;
}

const casScript = `
local current=redis.call('GET',KEYS[1])
if current then
  local ok,decoded=pcall(cjson.decode,current)
  if ok and decoded.activationRevision and tonumber(decoded.activationRevision)>tonumber(ARGV[1]) then return 0 end
end
redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3])
return 1`;

export class RedisActivePricingCache implements ActivePricingCache {
  readonly client: RedisClient;
  constructor(url: string) {
    this.client = new RedisClient(url, { connectionTimeout: 3000, idleTimeout: 30 });
  }
  get(cityId: string) { return this.client.get(`${ACTIVE_PRICING_CACHE_PREFIX}${cityId}`); }
  async writeIfNewer(cityId: string, value: ActivePricing, ttlSeconds: number) {
    const result = await this.client.send("EVAL", [casScript, "1", `${ACTIVE_PRICING_CACHE_PREFIX}${cityId}`, String(value.activationRevision), JSON.stringify(value), String(ttlSeconds)]);
    return Number(result) === 1;
  }
  close() { this.client.close(); }
}

export class FakeActivePricingCache implements ActivePricingCache {
  readonly values = new Map<string,string>();
  failReads = false;
  failWrites = false;
  reads = 0;
  writes = 0;
  async get(cityId:string) { this.reads++; if(this.failReads) throw new Error("fake redis unavailable"); return this.values.get(cityId) ?? null; }
  async writeIfNewer(cityId:string,value:ActivePricing,_ttlSeconds:number) {
    this.writes++; if(this.failWrites) throw new Error("fake redis unavailable");
    const raw=this.values.get(cityId); let revision=-1;
    try { revision=Number((JSON.parse(raw ?? "null") as {activationRevision?:number}|null)?.activationRevision ?? -1); } catch {}
    if(revision>value.activationRevision) return false;
    this.values.set(cityId,JSON.stringify(value)); return true;
  }
}

const integer=(value:unknown,min:number,max:number)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=min&&value<=max;
export function parseActivePricing(raw:string,expectedCityId:string):ActivePricing|null {
  try {
    const v=JSON.parse(raw) as Record<string,unknown>;
    if(v.cityId!==expectedCityId||v.status!=="ACTIVE"||v.routingProvider!=="OSRM"||v.currency!=="IQD"||v.routingMaxAttempts!==2) return null;
    if(typeof v.pricingVersionId!=="string"||typeof v.activatedAt!=="string"||!Number.isFinite(Date.parse(v.activatedAt))) return null;
    for(const key of ["versionNumber","activationRevision","routingTimeoutMs","baseFee","includedDistanceMeters","pricePerKm","roundingStep","fallbackExtraDistanceMeters"] as const) if(!integer(v[key],key==="roundingStep"||key==="versionNumber"||key==="activationRevision"||key==="routingTimeoutMs"?1:0,2_147_483_647)) return null;
    if(v.maximumDeliveryDistanceMeters!==null&&!integer(v.maximumDeliveryDistanceMeters,1,2_147_483_647)) return null;
    for(const key of ["routingFallbackEnabled","fallbackOnNoRoute","fallbackOnProviderFailure"] as const) if(typeof v[key]!=="boolean") return null;
    if(!v.routingFallbackEnabled&&(v.fallbackOnNoRoute||v.fallbackOnProviderFailure)) return null;
    return Object.freeze(v) as ActivePricing;
  } catch { return null; }
}
