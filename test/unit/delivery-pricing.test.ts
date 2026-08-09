import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import { calculateDeliveryFee, decimalFraction, fallbackPricingDistance } from "../../src/modules/delivery-pricing/pricing";
import { FakeRoutingProvider, fakeRoutingError } from "../../src/modules/delivery-pricing/routing-provider";

const terms={baseFee:1000,includedDistanceMeters:1000,pricePerKm:500,roundingStep:250,maximumDeliveryDistanceMeters:null};
describe("delivery pricing formula",()=>{
  test("included distance charges only base rounded to step",()=>expect(calculateDeliveryFee(999.9,terms)).toMatchObject({billableDistanceMeters:0,deliveryFee:1000}));
  test("uses unrounded routed decimal meters",()=>expect(calculateDeliveryFee(1000.1,terms)).toMatchObject({billableDistanceMeters:0.10000000000002274,deliveryFee:1250}));
  test("multiplies distance and rounds fee upward",()=>expect(calculateDeliveryFee(2500,terms).deliveryFee).toBe(1750));
  test("zero rates remain valid",()=>expect(calculateDeliveryFee(8000,{...terms,baseFee:0,pricePerKm:0}).deliveryFee).toBe(0));
  test("rejects maximum distance with required code",()=>{try{calculateDeliveryFee(2001,{...terms,maximumDeliveryDistanceMeters:2000});throw new Error("expected");}catch(e){expect(e).toBeInstanceOf(AppError);expect((e as AppError).publicCode).toBe("MAX_DISTANCE_EXCEEDED");}});
  test("fallback ceils sphere distance before adding extra",()=>expect(fallbackPricingDistance(1234.01,200)).toBe(1435));
  test("fallback leaves exact integer then adds extra",()=>expect(fallbackPricingDistance(1234,200)).toBe(1434));
  test("agreed 4275m example produces 3250 IQD",()=>expect(calculateDeliveryFee(4275,{...terms,includedDistanceMeters:0}).deliveryFee).toBe(3250));
  test("scientific notation is parsed without recursion",()=>{expect(decimalFraction(1e-7)).toEqual({numerator:1n,scale:10000000n});expect(()=>decimalFraction(1e21)).toThrow();});
});

describe("fake routing provider",()=>{
  test("returns configured route without rounding",async()=>expect(await new FakeRoutingProvider({distanceMeters:1234.56,durationSeconds:90.2}).route({latitude:0,longitude:0},{latitude:1,longitude:1},{requestId:"r",cityId:"c",storeId:"s",pricingVersionId:"p"})).toMatchObject({distanceMeters:1234.56,durationSeconds:90.2}));
  test("propagates no-route outcome",async()=>expect(new FakeRoutingProvider(fakeRoutingError("NO_ROUTE")).route({latitude:0,longitude:0},{latitude:1,longitude:1},{requestId:"r",cityId:"c",storeId:"s",pricingVersionId:"p"})).rejects.toMatchObject({details:{classification:"NO_ROUTE"}}));
});
