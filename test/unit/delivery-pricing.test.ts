import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/errors/app-error";
import { calculateDeliveryFee, fallbackPricingDistance } from "../../src/modules/delivery-pricing/pricing";
import { FakeRoutingProvider, RouteNotFoundError } from "../../src/modules/delivery-pricing/routing-provider";

const terms={baseFee:1000,includedDistanceMeters:1000,pricePerKm:500,roundingStep:250,maximumDeliveryDistanceMeters:null};
describe("delivery pricing formula",()=>{
  test("included distance charges only base rounded to step",()=>expect(calculateDeliveryFee(999.9,terms)).toEqual({billableDistanceMeters:0,deliveryFee:1000}));
  test("uses unrounded routed decimal meters",()=>expect(calculateDeliveryFee(1000.1,terms)).toEqual({billableDistanceMeters:0.10000000000002274,deliveryFee:1250}));
  test("multiplies distance and rounds fee upward",()=>expect(calculateDeliveryFee(2500,terms).deliveryFee).toBe(1750));
  test("zero rates remain valid",()=>expect(calculateDeliveryFee(8000,{...terms,baseFee:0,pricePerKm:0}).deliveryFee).toBe(0));
  test("rejects maximum distance with required code",()=>{try{calculateDeliveryFee(2001,{...terms,maximumDeliveryDistanceMeters:2000});throw new Error("expected");}catch(e){expect(e).toBeInstanceOf(AppError);expect((e as AppError).publicCode).toBe("MAX_DISTANCE_EXCEEDED");}});
  test("fallback ceils sphere distance before adding extra",()=>expect(fallbackPricingDistance(1234.01,200)).toBe(1435));
  test("fallback leaves exact integer then adds extra",()=>expect(fallbackPricingDistance(1234,200)).toBe(1434));
});

describe("fake routing provider",()=>{
  test("returns configured route without rounding",async()=>expect(await new FakeRoutingProvider({distanceMeters:1234.56,durationSeconds:90.2}).route()).toEqual({distanceMeters:1234.56,durationSeconds:90.2}));
  test("propagates no-route outcome",async()=>expect(new FakeRoutingProvider(new RouteNotFoundError()).route()).rejects.toBeInstanceOf(RouteNotFoundError));
});
