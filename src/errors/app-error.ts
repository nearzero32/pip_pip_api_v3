export class AppError extends Error {
  readonly statusCode: number;
  readonly publicCode: string;
  readonly retryAfterSeconds: number | undefined;
  readonly retryable: boolean | undefined;
  readonly details: Record<string, unknown> | undefined;
  constructor(
    messageOrStatus: string | number,
    statusOrCode: number | string,
    codeOrMessage: string,
    retryAfterSeconds?: number,
    retryable?: boolean,
    details?: Record<string, unknown>,
  ) {
    const modernOrder = typeof messageOrStatus === "number";
    super(modernOrder ? codeOrMessage : messageOrStatus);
    this.statusCode = modernOrder ? messageOrStatus : statusOrCode as number;
    this.publicCode = modernOrder ? statusOrCode as string : codeOrMessage;
    this.retryAfterSeconds = retryAfterSeconds;
    this.retryable = retryable;
    this.details = details;
    this.name = "AppError";
  }
}
