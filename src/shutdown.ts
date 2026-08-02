import type { Logger } from "./observability/logger";

export interface ShutdownDependencies {
  stopServer(): Promise<void>;
  closeDatabase(): Promise<void>;
  logger: Logger;
  timeoutMs: number;
  exit(code: number): void;
}

export function createShutdownHandler(dependencies: ShutdownDependencies): (signal: string) => Promise<void> {
  let shuttingDown = false;

  return async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    dependencies.logger.info({ event: "shutdown_started", signal });

    const deadline = setTimeout(() => {
      dependencies.logger.error({ event: "shutdown_timeout" });
      dependencies.exit(1);
    }, dependencies.timeoutMs);
    deadline.unref();

    try {
      await dependencies.stopServer();
      await dependencies.closeDatabase();
      clearTimeout(deadline);
      dependencies.logger.info({ event: "shutdown_completed" });
      dependencies.exit(0);
    } catch (error) {
      clearTimeout(deadline);
      dependencies.logger.error({ event: "shutdown_failed", error_name: error instanceof Error ? error.name : "UnknownError" });
      dependencies.exit(1);
    }
  };
}

export function registerSignalHandlers(shutdown: (signal: string) => Promise<void>): () => void {
  const onSigterm = (): void => { void shutdown("SIGTERM"); };
  const onSigint = (): void => { void shutdown("SIGINT"); };
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  return () => {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  };
}
