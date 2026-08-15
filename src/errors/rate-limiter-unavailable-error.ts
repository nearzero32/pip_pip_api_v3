import { AppError } from "./app-error";

export class RateLimiterUnavailableError extends AppError {
  readonly operation: string;
  readonly causeCode: string;

  constructor(operation: string, causeCode: string) {
    super(
      503,
      "RATE_LIMITER_UNAVAILABLE",
      "Authentication service is temporarily unavailable",
      undefined,
      true,
    );
    this.name = "RateLimiterUnavailableError";
    this.operation = operation;
    this.causeCode = causeCode;
  }
}

const PROGRAMMING_PATTERN =
  /wrongtype|syntax error|unknown command|noscript|err lua|invalid command|wrong number of arguments|compile/i;
const TRANSIENT_PATTERN =
  /connection|timeout|timed out|refused|network|unavailable|retry|closed|econn|eof|reset|not connected|socket|broken pipe|i\/o error/i;
const TRANSIENT_CODE =
  /ECONN|ETIMEDOUT|ENOTCONN|EPIPE|ECONNRESET|ECONNREFUSED|ENETUNREACH/i;

export function redisCauseCode(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN";
  const message = error.message.toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return "TIMEOUT";
  if (message.includes("refused")) return "CONNECTION_REFUSED";
  if (message.includes("closed") || message.includes("not connected"))
    return "CONNECTION_CLOSED";
  if (message.includes("retry")) return "RETRY_EXHAUSTED";
  if (message.includes("unavailable")) return "UNAVAILABLE";
  if (error.name === "RedisError") return "REDIS_ERROR";
  return "DEPENDENCY_ERROR";
}

export function isRedisTransientFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code =
    "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  const text = `${error.name} ${error.message}`;
  if (PROGRAMMING_PATTERN.test(text)) return false;
  if (TRANSIENT_CODE.test(code) || TRANSIENT_PATTERN.test(text)) return true;
  return error.name === "RedisError";
}

export function mapRedisRateLimiterFailure(
  error: unknown,
  operation: string,
): never {
  if (isRedisTransientFailure(error)) {
    throw new RateLimiterUnavailableError(operation, redisCauseCode(error));
  }
  throw error;
}
