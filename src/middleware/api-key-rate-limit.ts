// Per-key rate limiting for the /api/v1 jobs API (Stage 3).
//
// Runs AFTER apiKeyAuth, so it keys on the API key id and reads each key's own
// rate_limit_per_min. In-memory store (single process, like the existing IP
// limiters) — a distributed store is future work when the crawler scales out.

import { Request } from "express";
import rateLimit from "express-rate-limit";
import { ApiKeyRequest } from "./api-key-auth";
import { sendV1Error } from "../services/api/v1/respond";

const DEFAULT_PER_MIN = 60;

export const apiKeyRateLimiter = rateLimit({
  windowMs: 60_000,
  // Each key gets its own configured limit.
  max: (req: Request) => (req as ApiKeyRequest).apiKey?.rate_limit_per_min ?? DEFAULT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  // Key on the API key id; fall back to IP if (unexpectedly) unauthenticated.
  keyGenerator: (req: Request) => (req as ApiKeyRequest).apiKey?.id ?? req.ip ?? "unknown",
  handler: (_req, res) => {
    sendV1Error(
      res,
      429,
      "rate_limited",
      "Rate limit exceeded for this API key. Slow down and retry after the window resets.",
    );
  },
});
