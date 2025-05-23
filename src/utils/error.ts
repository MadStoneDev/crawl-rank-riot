export enum ErrorCode {
  VALIDATION_ERROR = "VALIDATION_ERROR",
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  NOT_FOUND = "NOT_FOUND",
  PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND",
  SCAN_NOT_FOUND = "SCAN_NOT_FOUND",
  DATABASE_ERROR = "DATABASE_ERROR",
  CRAWLER_ERROR = "CRAWLER_ERROR",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: any;

  constructor(
    message: string,
    code: string = ErrorCode.UNKNOWN_ERROR,
    details?: any,
    statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;

    // Capture stack trace
    Error.captureStackTrace(this, this.constructor);
  }
}

export class CrawlerError extends AppError {
  constructor(
    message: string,
    code: string = ErrorCode.CRAWLER_ERROR,
    details?: any,
  ) {
    super(message, code, details, 500);
    this.name = "CrawlerError";
  }
}

export function createValidationError(
  message: string,
  details?: any,
): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, details, 400);
}

export function handleError(error: unknown, context?: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    const message = context ? `${context}: ${error.message}` : error.message;
    return new AppError(message, ErrorCode.UNKNOWN_ERROR, {
      originalError: error.message,
    });
  }

  const message = context ? `${context}: ${String(error)}` : String(error);
  return new AppError(message, ErrorCode.UNKNOWN_ERROR, {
    originalError: error,
  });
}
