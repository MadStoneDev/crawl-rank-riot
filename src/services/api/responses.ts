import { ApiResponse } from "../../types/common";
import { AppError, ErrorCode } from "../../utils/error";

/**
 * Creates a successful API response
 * @param data Response data
 * @param message Success message
 * @returns Standardized success response object
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
 * Creates an error API response
 * @param message Error message
 * @param code Error code
 * @param details Error details
 * @returns Standardized error response object
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
 * Converts an AppError to an API error response
 * @param error Application error
 * @returns Standardized error response object
 */
export function errorToResponse(error: AppError): ApiResponse<never> {
  // Ensure error.code is of type ErrorCode
  const errorCode =
    typeof error.code === "string"
      ? Object.values(ErrorCode).includes(error.code as ErrorCode)
        ? (error.code as ErrorCode)
        : ErrorCode.UNKNOWN_ERROR
      : ErrorCode.UNKNOWN_ERROR;

  return createErrorResponse(error.message, errorCode, error.details);
}

/**
 * Error handler middleware for Express
 * @param err Error object
 * @param req Express request
 * @param res Express response
 * @param next Express next function
 */
export function errorHandlerMiddleware(
  err: any,
  req: any,
  res: any,
  next: any,
): void {
  console.error("Error occurred:", err);

  const appError =
    err instanceof AppError
      ? err
      : new AppError(
          err.message || "Internal Server Error",
          ErrorCode.UNKNOWN_ERROR,
          undefined,
          err.statusCode || 500,
        );

  res.status(appError.statusCode).json(errorToResponse(appError));
}
