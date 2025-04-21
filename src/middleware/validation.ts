import { Request, Response, NextFunction } from "express";
import { createValidationError } from "../utils/error";
import {
  validateRequiredFields,
  validateUrl,
  validateEmail,
  validateScanOptions,
} from "../utils/validation";

/**
 * Validates a scan request body
 * @param req Express request
 * @param res Express response
 * @param next Express next function
 */
export function validateScanRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    const { project_id, email, url, options } = req.body;

    // Validate required fields
    validateRequiredFields(req.body, ["project_id", "email"]);

    // Validate email format
    validateEmail(email);

    // Validate URL if provided directly (not through project)
    if (url) {
      validateUrl(url);
    }

    // Validate options if provided
    if (options) {
      validateScanOptions(options);
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Validates pagination parameters
 * @param req Express request
 * @param res Express response
 * @param next Express next function
 */
export function validatePagination(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    const { page, limit } = req.query;

    // Parse and validate page number
    if (page !== undefined) {
      const pageNum = parseInt(page as string, 10);
      if (isNaN(pageNum) || pageNum < 1) {
        throw createValidationError("Page number must be a positive integer", {
          field: "page",
        });
      }
      req.query.page = pageNum.toString();
    }

    // Parse and validate limit
    if (limit !== undefined) {
      const limitNum = parseInt(limit as string, 10);
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        throw createValidationError("Limit must be between 1 and 100", {
          field: "limit",
        });
      }
      req.query.limit = limitNum.toString();
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Validates request body against a schema
 * @param schema Validation schema with field type definitions
 * @returns Middleware function
 */
export function validateSchema(schema: Record<string, string>) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const errors: string[] = [];

      // Check each field against its required type
      Object.entries(schema).forEach(([field, type]) => {
        const value = req.body[field];

        // Skip undefined/null values unless required
        if (
          (value === undefined || value === null) &&
          !type.includes("required")
        ) {
          return;
        }

        // Check if field is required
        if (
          type.includes("required") &&
          (value === undefined || value === null)
        ) {
          errors.push(`${field} is required`);
          return;
        }

        // Check type
        if (value !== undefined && value !== null) {
          if (type.includes("string") && typeof value !== "string") {
            errors.push(`${field} must be a string`);
          } else if (type.includes("number") && typeof value !== "number") {
            errors.push(`${field} must be a number`);
          } else if (type.includes("boolean") && typeof value !== "boolean") {
            errors.push(`${field} must be a boolean`);
          } else if (type.includes("array") && !Array.isArray(value)) {
            errors.push(`${field} must be an array`);
          } else if (
            type.includes("object") &&
            (typeof value !== "object" || Array.isArray(value))
          ) {
            errors.push(`${field} must be an object`);
          }
        }

        // Check email format
        if (type.includes("email") && typeof value === "string") {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(value)) {
            errors.push(`${field} must be a valid email address`);
          }
        }

        // Check URL format
        if (type.includes("url") && typeof value === "string") {
          try {
            // Add protocol if missing
            const urlToCheck = !value.match(/^https?:\/\//)
              ? `https://${value}`
              : value;
            new URL(urlToCheck);
          } catch (e) {
            errors.push(`${field} must be a valid URL`);
          }
        }
      });

      // If there are validation errors, throw a validation error
      if (errors.length > 0) {
        throw createValidationError("Validation failed", { errors });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
