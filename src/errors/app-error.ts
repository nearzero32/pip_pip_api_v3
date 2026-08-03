export class AppError extends Error {
  readonly statusCode: number;
  readonly publicCode: string;
  constructor(
    messageOrStatus: string | number,
    statusOrCode: number | string,
    codeOrMessage: string,
  ) {
    const modernOrder = typeof messageOrStatus === "number";
    super(modernOrder ? codeOrMessage : messageOrStatus);
    this.statusCode = modernOrder ? messageOrStatus : statusOrCode as number;
    this.publicCode = modernOrder ? statusOrCode as string : codeOrMessage;
    this.name = "AppError";
  }
}
