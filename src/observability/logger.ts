import type { LogLevel } from "../config/env";
import { redact } from "../shared/redaction/redact";

export interface LogRecord {
  event: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(record: LogRecord): void;
  info(record: LogRecord): void;
  warn(record: LogRecord): void;
  error(record: LogRecord): void;
}

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(minimumLevel: LogLevel, write: (line: string) => void = console.log): Logger {
  const emit = (level: LogLevel, record: LogRecord): void => {
    if (priorities[level] < priorities[minimumLevel]) return;
    write(JSON.stringify(redact({ timestamp: new Date().toISOString(), level, ...record })));
  };
  return {
    debug: (record) => emit("debug", record),
    info: (record) => emit("info", record),
    warn: (record) => emit("warn", record),
    error: (record) => emit("error", record),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
