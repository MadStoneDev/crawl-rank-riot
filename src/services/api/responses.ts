import { Request, Response, NextFunction } from "express";
import { ApiResponse } from "../../types";
import { AppError, ErrorCode } from "../../utils/error";

/**
 * Create a successful API response
 */
export function createSuccessResponse<T>(
  data: T,
  message = "Operation successful",
): ApiResponse<T> {
  return {
    status: "success",
    message,
    data,
  };
}

/**
 * Create an error API response
 */
export function createErrorResponse(
  message: string,
  code: ErrorCode = ErrorCode.UNKNOWN_ERROR,
  details?: any,
): ApiResponse<never> {
  return {
    status: "error",
    message,
    error: {
      code,
      details,
    },
  };
}

/**
 * Convert AppError to API response format
 */
export function errorToResponse(error: AppError): ApiResponse<never> {
  // Ensure error.code is a valid ErrorCode
  const errorCode = Object.values(ErrorCode).includes(error.code as ErrorCode)
    ? (error.code as ErrorCode)
    : ErrorCode.UNKNOWN_ERROR;

  return createErrorResponse(error.message, errorCode, error.details);
}

/**
 * Express middleware for handling errors
 */
export function errorHandlerMiddleware(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Log the error for debugging (excluding request body to prevent sensitive data leakage)
  console.error("Error occurred:", {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    params: req.params,
    query: req.query,
  });

  // Convert to AppError if not already
  const appError =
    err instanceof AppError
      ? err
      : new AppError(
          err.message || "Internal Server Error",
          ErrorCode.UNKNOWN_ERROR,
          { originalError: err.message },
          err.statusCode || 500,
        );

  // Send error response
  res.status(appError.statusCode).json(errorToResponse(appError));
}

/**
 * Send not found response
 */
export function sendNotFound(
  res: Response,
  message = "Resource not found",
): void {
  res.status(404).json(createErrorResponse(message, ErrorCode.NOT_FOUND));
}

/**
 * Send unauthorized response
 */
export function sendUnauthorized(
  res: Response,
  message = "Unauthorized",
): void {
  res.status(401).json(createErrorResponse(message, ErrorCode.UNAUTHORIZED));
}

/**
 * Send forbidden response
 */
export function sendForbidden(res: Response, message = "Forbidden"): void {
  res.status(403).json(createErrorResponse(message, ErrorCode.FORBIDDEN));
}
