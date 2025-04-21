/**
 * Error handling utilities
 */

/**
 * Error codes used throughout the application
 */
export enum ErrorCode {
  // General errors
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  NOT_FOUND = "NOT_FOUND",

  // Crawler errors
  CRAWLER_INITIALIZATION_ERROR = "CRAWLER_INITIALIZATION_ERROR",
  FETCH_ERROR = "FETCH_ERROR",
  TIMEOUT_ERROR = "TIMEOUT_ERROR",
  PARSE_ERROR = "PARSE_ERROR",

  // Database errors
  DATABASE_CONNECTION_ERROR = "DATABASE_CONNECTION_ERROR",
  DATABASE_QUERY_ERROR = "DATABASE_QUERY_ERROR",

  // Authentication errors
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
}

/**
 * Custom application error class
 */
export class AppError extends Error {
  /**
   * Creates a new application error
   * @param message Error message
   * @param code Error code
   * @param details Additional error details
   */
  constructor(
    message: string,
    public readonly code: ErrorCode | string,
    public readonly details?: any,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }
}

/**
 * Crawler-specific error class
 */
export class CrawlerError extends AppError {
  constructor(
    message: string,
    code: ErrorCode | string,
    details?: any,
    statusCode = 500,
  ) {
    super(message, code, details, statusCode);
    this.name = "CrawlerError";
  }
}

/**
 * Handles unknown errors and converts them to AppError
 * @param error Any caught error
 * @param context Context where the error occurred
 * @returns Normalized AppError
 */
export function handleError(error: unknown, context: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new AppError(`${context}: ${message}`, ErrorCode.UNKNOWN_ERROR);
}

/**
 * Creates a not found error
 * @param entity Entity type that wasn't found
 * @param id Identifier that was searched for
 * @returns Not found error
 */
export function createNotFoundError(entity: string, id: string): AppError {
  return new AppError(
    `${entity} with ID ${id} not found`,
    ErrorCode.NOT_FOUND,
    { entity, id },
    404,
  );
}

/**
 * Creates a validation error
 * @param message Validation error message
 * @param details Validation error details
 * @returns Validation error
 */
export function createValidationError(
  message: string,
  details?: any,
): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, details, 400);
}
