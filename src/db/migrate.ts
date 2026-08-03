import { loadDatabaseConfig } from "../config/env";
import { createDatabaseClient } from "./client";
import { applyMigrations } from "./migration-runner";

const config = loadDatabaseConfig();
const database = createDatabaseClient(config);

try {
  await applyMigrations(database.client);
  console.log(JSON.stringify({ level: "info", event: "database_migrations_applied" }));
} finally {
  await database.close();
}
