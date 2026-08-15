import { describe, expect, test } from "bun:test";
import { silentLogger } from "../../src/observability/logger";
import { createShutdownHandler, registerSignalHandlers } from "../../src/shutdown";

describe("graceful shutdown", () => {
  test("stops the server before closing the database and exits successfully once", async () => {
    const events: string[] = [];
    const shutdown = createShutdownHandler({
      stopServer: async () => { events.push("server"); },
      closeDatabase: async () => { events.push("database"); },
      logger: silentLogger,
      timeoutMs: 1_000,
      exit: (code) => { events.push(`exit:${code}`); },
    });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(events).toEqual(["server", "database", "exit:0"]);
  });

  test("closes Redis clients during shutdown even if close is repeated", async () => {
    const events: string[] = [];
    let closes = 0;
    const limiter = {
      close: async () => {
        closes++;
        events.push("redis");
      },
    };
    const shutdown = createShutdownHandler({
      stopServer: async () => { events.push("server"); },
      closeDatabase: async () => {
        await limiter.close();
        await limiter.close();
        events.push("database");
      },
      logger: silentLogger,
      timeoutMs: 1_000,
      exit: (code) => { events.push(`exit:${code}`); },
    });
    await shutdown("SIGTERM");
    expect(closes).toBe(2);
    expect(events).toEqual(["server", "redis", "redis", "database", "exit:0"]);
  });

  test("signal registration can be removed without leaving duplicate test handlers", () => {
    const before = process.listenerCount("SIGTERM");
    const unregister = registerSignalHandlers(async () => undefined);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    unregister();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
