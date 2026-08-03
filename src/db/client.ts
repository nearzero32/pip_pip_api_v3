import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import type { DatabaseConfig } from "../config/env";
import * as schema from "./schema";

export type DatabaseClient = ReturnType<typeof createDatabaseClient>;

export function createDatabaseClient(config: DatabaseConfig) {
  const client = new SQL(config.databaseUrl, {
    max: config.databasePoolSize,
    connectionTimeout: config.databaseConnectionTimeoutMs / 1_000,
  });
  const db = drizzle({ client, schema });
  return {
    client,
    db,
    async ping(): Promise<void> {
      await client`select 1`;
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}
