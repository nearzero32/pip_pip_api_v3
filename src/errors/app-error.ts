export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly publicCode: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
