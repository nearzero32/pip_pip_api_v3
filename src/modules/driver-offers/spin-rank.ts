import { createHash } from "crypto";
import type { OpenOfferSummary } from "./driver-runtime";

export type SpinRankConfig = {
  maxOffers: number;
  /** Coarse age band so older offers stay ahead of newer ones. */
  ageBucketMs: number;
  /** Rolling window that reshuffles within an age band. */
  rotationWindowMs: number;
};

export const DEFAULT_SPIN_RANK: SpinRankConfig = {
  maxOffers: 5,
  ageBucketMs: 60_000,
  rotationWindowMs: 15_000,
};

export const rotationScore = (
  driverId: string,
  offerId: string,
  rotationBucket: number,
): number => {
  const digest = createHash("sha256")
    .update(`${driverId}:${offerId}:${rotationBucket}`)
    .digest();
  return digest.readUInt32BE(0);
};

/**
 * Rank open offers for a driver spin:
 * 1. Older age buckets always precede newer ones (no starvation).
 * 2. Within the same age bucket, order is deterministic per driver + rotation window.
 * 3. Cap at maxOffers.
 */
export function rankOffersForSpin(
  offers: OpenOfferSummary[],
  driverId: string,
  now: Date,
  config: SpinRankConfig = DEFAULT_SPIN_RANK,
): OpenOfferSummary[] {
  const nowMs = now.getTime();
  const rotationBucket = Math.floor(nowMs / config.rotationWindowMs);
  const ranked = offers.map((offer) => {
    const openedMs = new Date(offer.openedAt).getTime();
    const ageMs = Math.max(0, nowMs - openedMs);
    const ageBucket = Math.floor(ageMs / config.ageBucketMs);
    return {
      offer,
      ageBucket,
      rot: rotationScore(driverId, offer.offerId, rotationBucket),
    };
  });
  ranked.sort((a, b) => {
    if (a.ageBucket !== b.ageBucket) return b.ageBucket - a.ageBucket;
    if (a.rot !== b.rot) return a.rot - b.rot;
    return a.offer.offerId.localeCompare(b.offer.offerId);
  });
  return ranked.slice(0, config.maxOffers).map((row) => row.offer);
}
