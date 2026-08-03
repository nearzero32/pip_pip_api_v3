export class AppError extends Error {
  readonly statusCode: number;
  readonly publicCode: string;
  readonly retryAfterSeconds: number | undefined;
  constructor(
    messageOrStatus: string | number,
    statusOrCode: number | string,
    codeOrMessage: string,
    retryAfterSeconds?: number,
  ) {
    const modernOrder = typeof messageOrStatus === "number";
    super(modernOrder ? codeOrMessage : messageOrStatus);
    this.statusCode = modernOrder ? messageOrStatus : statusOrCode as number;
    this.publicCode = modernOrder ? statusOrCode as string : codeOrMessage;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "AppError";
  }
}
