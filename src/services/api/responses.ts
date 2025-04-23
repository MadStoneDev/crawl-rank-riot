import { ApiResponse } from "../../types/common";
import { AppError, ErrorCode } from "../../utils/error";

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
