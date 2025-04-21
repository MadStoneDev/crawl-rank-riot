import { Request, Response, NextFunction } from "express";
import { AppError, ErrorCode } from "../utils/error";
import { getSupabaseClient } from "../services/database/client";

/**
 * Request with authenticated user
 */
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

/**
 * Middleware to authenticate users via JWT token
 * @param req Express request
 * @param res Express response
 * @param next Express next function
 */
export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Extract authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError(
        "Authorization token is required",
        ErrorCode.UNAUTHORIZED,
        undefined,
        401,
      );
    }

    const token = authHeader.split(" ")[1];

    // Get Supabase client
    const supabase = getSupabaseClient();

    // Verify JWT token
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new AppError(
        "Invalid or expired token",
        ErrorCode.UNAUTHORIZED,
        undefined,
        401,
      );
    }

    // Attach user data to request
    req.user = {
      id: user.id,
      email: user.email || "",
    };

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Middleware to check if user has access to a project
 * @param req Express request
 * @param res Express response
 * @param next Express next function
 */
export async function projectAccessMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Ensure user is authenticated
    if (!req.user) {
      throw new AppError(
        "Authentication required",
        ErrorCode.UNAUTHORIZED,
        undefined,
        401,
      );
    }

    // Get project ID from request parameters or body
    const projectId = req.params.projectId || req.body.project_id;

    if (!projectId) {
      throw new AppError(
        "Project ID is required",
        ErrorCode.VALIDATION_ERROR,
        undefined,
        400,
      );
    }

    // Get Supabase client
    const supabase = getSupabaseClient();

    // Check if user has access to this project
    const { data, error } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("user_id", req.user.id)
      .single();

    if (error || !data) {
      throw new AppError(
        "You do not have access to this project",
        ErrorCode.FORBIDDEN,
        undefined,
        403,
      );
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Simple API key authentication for service-to-service calls
 * Note: This is a basic implementation. For production, consider using a more robust approach.
 * @param req Express request
 * @param res Express response
 * @param next Express next function
 */
export function apiKeyServiceAuth(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestApiKey = req.headers["x-api-key"] as string;

      if (!requestApiKey || requestApiKey !== apiKey) {
        throw new AppError(
          "Invalid API key",
          ErrorCode.UNAUTHORIZED,
          undefined,
          401,
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
