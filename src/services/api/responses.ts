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
  // Log the error for debugging
  console.error("Error occurred:", {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    body: req.body,
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
 * Middleware to handle async route errors
 */
export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Send paginated response
 */
export function createPaginatedResponse<T>(
  data: T[],
  total: number,
  page: number = 1,
  limit: number = 10,
  message = "Data retrieved successfully",
): ApiResponse<{
  items: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}> {
  const totalPages = Math.ceil(total / limit);

  return createSuccessResponse(
    {
      items: data,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    },
    message,
  );
}

/**
 * Middleware to validate request body against schema
 */
export function validateRequestBody(requiredFields: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const missingFields = requiredFields.filter((field) => {
      return (
        req.body[field] === undefined ||
        req.body[field] === null ||
        req.body[field] === ""
      );
    });

    if (missingFields.length > 0) {
      return next(
        new AppError(
          `Missing required fields: ${missingFields.join(", ")}`,
          ErrorCode.VALIDATION_ERROR,
          { missingFields },
          400,
        ),
      );
    }

    next();
  };
}

/**
 * Middleware to validate request parameters
 */
export function validateRequestParams(requiredParams: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const missingParams = requiredParams.filter((param) => {
      return req.params[param] === undefined || req.params[param] === "";
    });

    if (missingParams.length > 0) {
      return next(
        new AppError(
          `Missing required parameters: ${missingParams.join(", ")}`,
          ErrorCode.VALIDATION_ERROR,
          { missingParams },
          400,
        ),
      );
    }

    next();
  };
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
