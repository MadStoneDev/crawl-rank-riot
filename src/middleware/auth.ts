import { Request, Response, NextFunction } from "express";
import { sendUnauthorized } from "../services/api/responses";
import { getSupabaseClient } from "../services/database/client";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email?: string;
  };
}

/**
 * Middleware that verifies Supabase JWT tokens from the Authorization header.
 * Attaches user info to req.user on success.
 */
export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    sendUnauthorized(res, "Missing or invalid Authorization header");
    return;
  }

  const token = authHeader.slice(7);

  if (!token) {
    sendUnauthorized(res, "Missing token");
    return;
  }

  const supabase = getSupabaseClient();

  supabase.auth
    .getUser(token)
    .then(({ data, error }) => {
      if (error || !data.user) {
        sendUnauthorized(res, "Invalid or expired token");
        return;
      }

      req.user = {
        id: data.user.id,
        email: data.user.email,
      };

      next();
    })
    .catch(() => {
      sendUnauthorized(res, "Token verification failed");
    });
}
