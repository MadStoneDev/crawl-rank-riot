import { Request, Response, NextFunction } from "express";
import { AppError, ErrorCode } from "../utils/error";
import { createErrorResponse } from "../services/api/responses";

/**
 * Global error handling middleware
 * Catches errors and formats them as standardized API responses
 */
export function errorMiddleware(
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Log the error
  console.error("Error:", err);

  // If it's already an AppError, use its properties
  if (err instanceof AppError) {
    // Ensure err.code is a valid ErrorCode enum value
    const errorCode = Object.values(ErrorCode).includes(err.code as ErrorCode)
      ? (err.code as ErrorCode)
      : ErrorCode.UNKNOWN_ERROR;

    res
      .status(err.statusCode)
      .json(createErrorResponse(err.message, errorCode, err.details));
    return;
  }

  // Default error response for unexpected errors
  const statusCode = 500;
  const code = ErrorCode.UNKNOWN_ERROR;
  const message =
    process.env.NODE_ENV === "development"
      ? err.message || "An unknown error occurred"
      : "An unexpected error occurred";

  res.status(statusCode).json(
    createErrorResponse(message, code, {
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    }),
  );
}

/**
 * 404 Not Found middleware
 * Handles routes that don't match any endpoints
 */
export function notFoundMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const error = new AppError(
    `Not Found - ${req.originalUrl}`,
    ErrorCode.NOT_FOUND,
    { path: req.originalUrl },
    404,
  );

  next(error);
}

/**
 * Request timeout middleware
 * Sets a maximum time for request processing
 * @param timeout Timeout in milliseconds
 */
export function timeoutMiddleware(timeout: number = 30000) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Set timeout for the request
    const timeoutId = setTimeout(() => {
      const error = new AppError(
        "Request timeout",
        ErrorCode.TIMEOUT_ERROR,
        { timeout },
        408,
      );
      next(error);
    }, timeout);

    // Clear timeout when the response is sent
    res.on("finish", () => {
      clearTimeout(timeoutId);
    });

    next();
  };
}

/**
 * Rate limiting middleware
 * Limits the number of requests from a single IP
 * @param maxRequests Maximum number of requests per window
 * @param windowMs Time window in milliseconds
 */
export function rateLimitMiddleware(
  maxRequests: number = 100,
  windowMs: number = 60000,
) {
  const ipRequestCounts = new Map<string, number>();
  const ipTimestamps = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    // Get timestamps for this IP
    const timestamps = ipTimestamps.get(ip) || [];

    // Filter out timestamps outside current window
    const validTimestamps = timestamps.filter((ts) => now - ts < windowMs);

    // Check if request limit is exceeded
    if (validTimestamps.length >= maxRequests) {
      // Ensure we use an existing error code or add the missing one to the enum
      const error = new AppError(
        "Too many requests",
        ErrorCode.UNKNOWN_ERROR, // Changed from RATE_LIMIT_EXCEEDED to UNKNOWN_ERROR
        { maxRequests, windowMs },
        429,
      );
      next(error);
      return;
    }

    // Add current timestamp
    validTimestamps.push(now);
    ipTimestamps.set(ip, validTimestamps);

    // Increment request count
    const count = (ipRequestCounts.get(ip) || 0) + 1;
    ipRequestCounts.set(ip, count);

    // Add rate limit headers
    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader(
      "X-RateLimit-Remaining",
      Math.max(0, maxRequests - validTimestamps.length),
    );

    next();
  };
}
