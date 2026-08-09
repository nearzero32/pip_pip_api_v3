import { AppError } from "../../errors/app-error";

export type PricingTerms = { baseFee:number; includedDistanceMeters:number; pricePerKm:number; roundingStep:number; maximumDeliveryDistanceMeters:number|null };

const decimalFraction = (value:number) => {
  if (!Number.isFinite(value) || value < 0) throw new AppError(422,"VALIDATION_FAILED","Invalid distance");
  const string = value.toString();
  if (/e/i.test(string)) {
    const fixed = value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
    return decimalFraction(Number(fixed));
  }
  const [whole, fraction=""] = string.split(".");
  const scale=10n ** BigInt(fraction.length);
  return { numerator: BigInt(whole!)*scale+BigInt(fraction || "0"), scale };
};

export function calculateDeliveryFee(distanceMeters:number, terms:PricingTerms) {
  if (terms.maximumDeliveryDistanceMeters != null && distanceMeters > terms.maximumDeliveryDistanceMeters) {
    throw new AppError(422,"MAX_DISTANCE_EXCEEDED","Maximum delivery distance exceeded");
  }
  const distance=decimalFraction(distanceMeters);
  const included=BigInt(terms.includedDistanceMeters)*distance.scale;
  const billable=distance.numerator > included ? distance.numerator-included : 0n;
  const denominator=1000n*distance.scale;
  const rawNumerator=BigInt(terms.baseFee)*denominator+billable*BigInt(terms.pricePerKm);
  const stepDenominator=denominator*BigInt(terms.roundingStep);
  const steps=(rawNumerator+stepDenominator-1n)/stepDenominator;
  const fee=steps*BigInt(terms.roundingStep);
  if (fee > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError(422,"VALIDATION_FAILED","Calculated fee is too large");
  return { billableDistanceMeters: Math.max(0,distanceMeters-terms.includedDistanceMeters), deliveryFee:Number(fee) };
}

/** PostGIS distance is rounded upward first; the configured safety distance is then added. */
export const fallbackPricingDistance = (straightLineDistanceMeters:number, extraMeters:number) => Math.ceil(straightLineDistanceMeters)+extraMeters;
