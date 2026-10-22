// API-key authentication for the /api/v1 jobs API (Stage 3).
//
// A parallel auth strategy to the JWT authMiddleware (which is untouched).
// Reads a key from `Authorization: Bearer rrk_...` or the `X-API-Key` header,
// verifies it, checks the required scope, and attaches req.apiKey. Each
// authenticated request is metered (best-effort, never blocking).

import { Request, Response, NextFunction } from "express";
import {
  verifyApiKey,
  hasScope,
  type ApiKeyRecord,
  type ApiScope,
} from "../services/api/v1/keys";
import { recordUsage } from "../services/api/v1/usage";
import { sendV1Error } from "../services/api/v1/respond";

export interface ApiKeyRequest extends Request {
  apiKey?: ApiKeyRecord;
}

function presentedKey(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice(7).trim();
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.length > 0) return xApiKey.trim();
  return undefined;
}

/**
 * Require a valid API key (and optionally a scope). Returns an Express
 * middleware so routes read `apiKeyAuth("jobs:write")`.
 */
export function apiKeyAuth(requiredScope?: ApiScope) {
  return async (req: ApiKeyRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await verifyApiKey(presentedKey(req));
      if (!result.ok) {
        if (result.reason === "revoked") {
          sendV1Error(res, 401, "key_revoked", "This API key has been revoked.");
        } else {
          sendV1Error(
            res,
            401,
            "invalid_api_key",
            "Missing or invalid API key. Send it as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'.",
          );
        }
        return;
      }

      if (requiredScope && !hasScope(result.record, requiredScope)) {
        sendV1Error(
          res,
          403,
          "insufficient_scope",
          `This API key is missing the required scope '${requiredScope}'.`,
          { required_scope: requiredScope, scopes: result.record.scopes },
        );
        return;
      }

      req.apiKey = result.record;
      // Meter the request (best-effort; recordUsage swallows its own errors).
      void recordUsage(result.record.id, { requests: 1 });
      next();
    } catch {
      sendV1Error(res, 500, "auth_error", "Could not verify the API key.");
    }
  };
}
