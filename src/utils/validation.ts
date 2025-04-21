import { createValidationError } from "./error";

/**
 * Validates that required fields are present
 * @param data Object to validate
 * @param requiredFields Array of required field names
 * @throws ValidationError if required fields are missing
 */
export function validateRequiredFields(
  data: Record<string, any>,
  requiredFields: string[],
): void {
  const missingFields = requiredFields.filter((field) => {
    const value = data[field];
    return value === undefined || value === null || value === "";
  });

  if (missingFields.length > 0) {
    throw createValidationError(
      `Missing required fields: ${missingFields.join(", ")}`,
      { missingFields },
    );
  }
}

/**
 * Validates that a string is a valid URL
 * @param url URL to validate
 * @returns True if URL is valid
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Validates that a URL string is valid
 * @param url URL to validate
 * @param fieldName Name of the field for error message
 * @throws ValidationError if URL is invalid
 */
export function validateUrl(url: string, fieldName = "URL"): void {
  if (!url) {
    throw createValidationError(`${fieldName} is required`);
  }

  // Ensure URL has a protocol
  let urlWithProtocol = url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    urlWithProtocol = `https://${url}`;
  }

  if (!isValidUrl(urlWithProtocol)) {
    throw createValidationError(`${fieldName} is not a valid URL: ${url}`);
  }
}

/**
 * Validates that a number is within a specified range
 * @param value Number to validate
 * @param min Minimum allowed value
 * @param max Maximum allowed value
 * @param fieldName Name of the field for error message
 * @throws ValidationError if number is out of range
 */
export function validateNumberRange(
  value: number,
  min: number,
  max: number,
  fieldName = "Value",
): void {
  if (value < min || value > max) {
    throw createValidationError(
      `${fieldName} must be between ${min} and ${max}`,
      { value, min, max, field: fieldName },
    );
  }
}

/**
 * Validates an email address format
 * @param email Email to validate
 * @throws ValidationError if email is invalid
 */
export function validateEmail(email: string): void {
  if (!email) {
    throw createValidationError("Email is required");
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw createValidationError("Invalid email format");
  }
}

/**
 * Validates scan options
 * @param options Options to validate
 * @throws ValidationError if options are invalid
 */
export function validateScanOptions(options: Record<string, any> = {}): void {
  // Validate maxDepth
  if (options.maxDepth !== undefined) {
    if (typeof options.maxDepth !== "number" || options.maxDepth < 1) {
      throw createValidationError("maxDepth must be a positive number", {
        field: "maxDepth",
      });
    }
    validateNumberRange(options.maxDepth, 1, 10, "maxDepth");
  }

  // Validate maxPages
  if (options.maxPages !== undefined) {
    if (typeof options.maxPages !== "number" || options.maxPages < 1) {
      throw createValidationError("maxPages must be a positive number", {
        field: "maxPages",
      });
    }
    validateNumberRange(options.maxPages, 1, 1000, "maxPages");
  }

  // Validate concurrentRequests
  if (options.concurrentRequests !== undefined) {
    if (
      typeof options.concurrentRequests !== "number" ||
      options.concurrentRequests < 1
    ) {
      throw createValidationError(
        "concurrentRequests must be a positive number",
        { field: "concurrentRequests" },
      );
    }
    validateNumberRange(
      options.concurrentRequests,
      1,
      10,
      "concurrentRequests",
    );
  }

  // Validate timeout
  if (options.timeout !== undefined) {
    if (typeof options.timeout !== "number" || options.timeout < 1000) {
      throw createValidationError("timeout must be at least 1000ms", {
        field: "timeout",
      });
    }
    validateNumberRange(options.timeout, 1000, 300000, "timeout"); // Between 1s and 5min
  }
}
