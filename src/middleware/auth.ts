import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { sendUnauthorized } from "../services/api/responses";

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

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Auth middleware: Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    res.status(500).json({ status: "error", message: "Server configuration error" });
    return;
  }

  // Create a one-off client with the user's token to verify it
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });

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
