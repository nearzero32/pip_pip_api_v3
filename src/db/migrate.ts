import { migrate } from "drizzle-orm/bun-sql/migrator";
import { loadConfig } from "../config/env";
import { createDatabaseClient } from "./client";

const config = loadConfig();
const database = createDatabaseClient(config);

try {
  await migrate(database.db, { migrationsFolder: "./drizzle" });
  console.log(JSON.stringify({ level: "info", event: "database_migrations_applied" }));
} finally {
  await database.close();
}
