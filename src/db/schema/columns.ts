import { timestamp } from "drizzle-orm/pg-core";

export const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
