import type { NodeEnvironment } from "../../config/env";

export type RedisNamespaceEnv = NodeEnvironment;

export const redisAppPrefix = (environment: RedisNamespaceEnv) =>
  `pip-pip:${environment}`;

export const driverRuntimeKey = (
  environment: RedisNamespaceEnv,
  driverId: string,
) => `${redisAppPrefix(environment)}:driver:runtime:${driverId}`;

export const driverRuntimeHydrateLockKey = (
  environment: RedisNamespaceEnv,
  driverId: string,
) => `${redisAppPrefix(environment)}:driver:runtime:hydrate:${driverId}`;

export const cityOpenOffersKey = (
  environment: RedisNamespaceEnv,
  cityId: string,
) => `${redisAppPrefix(environment)}:city:${cityId}:open-offers`;

export const cityOpenOffersRevisionKey = (
  environment: RedisNamespaceEnv,
  cityId: string,
) => `${redisAppPrefix(environment)}:city:${cityId}:open-offers:revision`;

export const offerSummaryKey = (
  environment: RedisNamespaceEnv,
  offerId: string,
) => `${redisAppPrefix(environment)}:offer:${offerId}`;

export const driverLocationKey = (
  environment: RedisNamespaceEnv,
  driverId: string,
) => `${redisAppPrefix(environment)}:driver:location:${driverId}`;

export const rateLimitNamespacedKey = (
  environment: RedisNamespaceEnv,
  scope: string,
  identity: string,
) =>
  `${redisAppPrefix(environment)}:rate-limit:${encodeURIComponent(scope)}:${encodeURIComponent(identity)}`;
