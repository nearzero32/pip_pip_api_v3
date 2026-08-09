import { AppError } from "../../errors/app-error";

export const PRICING_INTEGER_MAX=2_147_483_647;
export type PricingTerms={baseFee:number;includedDistanceMeters:number;pricePerKm:number;roundingStep:number;maximumDeliveryDistanceMeters:number|null};
type Fraction={numerator:bigint;scale:bigint};

export function decimalFraction(value:number):Fraction {
  if(!Number.isFinite(value)||value<0||value>PRICING_INTEGER_MAX) throw new AppError(422,"VALIDATION_FAILED","Invalid distance");
  const match=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.toString());
  if(!match) throw new AppError(422,"VALIDATION_FAILED","Invalid distance");
  const fraction=match[2]??""; const exponent=Number(match[3]??0); const digits=BigInt(`${match[1]}${fraction}`); const decimalPlaces=fraction.length-exponent;
  return decimalPlaces<=0?{numerator:digits*10n**BigInt(-decimalPlaces),scale:1n}:{numerator:digits,scale:10n**BigInt(decimalPlaces)};
}

export function calculateDeliveryFee(distanceMeters:number,terms:PricingTerms){
  if(terms.maximumDeliveryDistanceMeters!=null&&distanceMeters>terms.maximumDeliveryDistanceMeters) throw new AppError(422,"MAX_DISTANCE_EXCEEDED","Maximum delivery distance exceeded");
  const distance=decimalFraction(distanceMeters);const included=BigInt(terms.includedDistanceMeters)*distance.scale;const billable=distance.numerator>included?distance.numerator-included:0n;const denominator=1000n*distance.scale;
  const rawNumerator=BigInt(terms.baseFee)*denominator+billable*BigInt(terms.pricePerKm);const stepDenominator=denominator*BigInt(terms.roundingStep);const steps=(rawNumerator+stepDenominator-1n)/stepDenominator;const fee=steps*BigInt(terms.roundingStep);
  if(fee>BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError(422,"VALIDATION_FAILED","Calculated fee is too large");
  return {billableDistanceMeters:Math.max(0,distanceMeters-terms.includedDistanceMeters),rawCalculation:{numerator:rawNumerator.toString(),denominator:denominator.toString()},deliveryFee:Number(fee)};
}

export const fallbackPricingDistance=(straightLineDistanceMeters:number,extraMeters:number)=>Math.ceil(straightLineDistanceMeters)+extraMeters;
