import { AppError } from "../../errors/app-error";
import type { DriverPricingStage } from "../../db/schema/driver-offers";

/** Half-up rounding to the nearest positive integer unit (deterministic). */
export function roundToNearestUnit(value: number, roundingUnit: number): number {
  if (!Number.isInteger(roundingUnit) || roundingUnit <= 0) {
    throw new AppError(500, "INTERNAL_ERROR", "Invalid rounding unit");
  }
  if (!Number.isFinite(value)) {
    throw new AppError(500, "INTERNAL_ERROR", "Invalid fee value");
  }
  const quotient = value / roundingUnit;
  const floored = Math.floor(quotient);
  const fraction = quotient - floored;
  // Midpoint (*.5) and above round away from zero (up for positive fees).
  if (fraction >= 0.5) return (floored + 1) * roundingUnit;
  return floored * roundingUnit;
}

export function validatePricingStages(
  stages: DriverPricingStage[],
): DriverPricingStage[] {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new AppError(
      422,
      "VALIDATION_FAILED",
      "At least one pricing stage is required",
    );
  }
  const normalized = stages.map((stage) => {
    if (
      !stage ||
      typeof stage.afterSeconds !== "number" ||
      typeof stage.increasePercentage !== "number" ||
      !Number.isInteger(stage.afterSeconds) ||
      !Number.isInteger(stage.increasePercentage)
    ) {
      throw new AppError(422, "VALIDATION_FAILED", "Invalid pricing stage");
    }
    if (stage.afterSeconds < 0 || stage.increasePercentage < 0) {
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Pricing stage values must be non-negative",
      );
    }
    return {
      afterSeconds: stage.afterSeconds,
      increasePercentage: stage.increasePercentage,
    };
  });
  if (normalized[0]!.afterSeconds !== 0) {
    throw new AppError(
      422,
      "VALIDATION_FAILED",
      "First pricing stage must start at 0 seconds",
    );
  }
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i]!.afterSeconds <= normalized[i - 1]!.afterSeconds) {
      throw new AppError(
        422,
        "VALIDATION_FAILED",
        "Pricing stages must be strictly ascending by afterSeconds",
      );
    }
  }
  return normalized;
}

export function selectStage(
  stages: DriverPricingStage[],
  elapsedSeconds: number,
): DriverPricingStage {
  const ordered = [...stages].sort((a, b) => a.afterSeconds - b.afterSeconds);
  let current = ordered[0]!;
  for (const stage of ordered) {
    if (elapsedSeconds >= stage.afterSeconds) current = stage;
    else break;
  }
  return current;
}

export function computeOfferedDriverFee(input: {
  pricingBase: number;
  roundingUnit: number;
  pricingStages: DriverPricingStage[];
  openedAt: Date;
  now: Date;
}): { offeredDriverFee: number; stage: DriverPricingStage; elapsedSeconds: number } {
  if (!Number.isInteger(input.pricingBase) || input.pricingBase <= 0) {
    throw new AppError(500, "INTERNAL_ERROR", "Invalid pricing base");
  }
  const stages = validatePricingStages(input.pricingStages);
  const elapsedSeconds = Math.max(
    0,
    Math.floor((input.now.getTime() - input.openedAt.getTime()) / 1000),
  );
  const stage = selectStage(stages, elapsedSeconds);
  const rawFee =
    input.pricingBase +
    (input.pricingBase * stage.increasePercentage) / 100;
  const offeredDriverFee = roundToNearestUnit(rawFee, input.roundingUnit);
  if (offeredDriverFee <= 0) {
    throw new AppError(500, "INTERNAL_ERROR", "Computed driver fee is invalid");
  }
  return { offeredDriverFee, stage, elapsedSeconds };
}
