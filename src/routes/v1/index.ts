// /api/v1 — the public, API-key-authenticated jobs API (Stage 3).
//
// Mounted in app.ts BEFORE the JWT-protected /api router and before the IP
// rate limiters, so it is governed solely by its own API-key auth and per-key
// rate limiter. /health and /meta are public; everything else requires a key.

import { Router, Response } from "express";
import { API_VERSION, SCHEMA_VERSION } from "../../services/api/v1/version";
import { apiKeyAuth, requireScope, ApiKeyRequest } from "../../middleware/api-key-auth";
import { apiKeyRateLimiter } from "../../middleware/api-key-rate-limit";
import { getCurrentUsage } from "../../services/api/v1/usage";
import { serializeUsage } from "../../services/api/v1/serializers";
import { sendV1, sendV1Error } from "../../services/api/v1/respond";
import { API_SCOPES } from "../../services/api/v1/keys";
import jobsRouter from "./jobs";

const router = Router();

// Public: liveness.
router.get("/health", (_req, res) => {
  res.json({ status: "ok", api_version: API_VERSION, timestamp: new Date().toISOString() });
});

// Public: surface metadata (versions + scopes) for client discovery.
router.get("/meta", (_req, res) => {
  sendV1(res, 200, {
    object: "meta",
    api_version: API_VERSION,
    schema_version: SCHEMA_VERSION,
    scopes: API_SCOPES,
    endpoints: [
      "POST /api/v1/jobs",
      "GET /api/v1/jobs",
      "GET /api/v1/jobs/:id",
      "GET /api/v1/jobs/:id/report",
      "GET /api/v1/jobs/:id/issues",
      "POST /api/v1/jobs/:id/cancel",
      "GET /api/v1/usage",
    ],
  });
});

// Everything below requires a valid API key and is rate-limited per key.
router.use(apiKeyAuth());
router.use(apiKeyRateLimiter);

// GET /api/v1/usage — this key's current calendar-month usage.
router.get("/usage", requireScope("jobs:read"), async (req: ApiKeyRequest, res: Response): Promise<void> => {
  try {
    const { periodStart, usage } = await getCurrentUsage(req.apiKey!.id);
    sendV1(res, 200, serializeUsage(periodStart, usage.requests, usage.jobs_created, req.apiKey!.monthly_quota));
  } catch {
    sendV1Error(res, 500, "internal_error", "Could not load usage.");
  }
});

router.use(jobsRouter);

export default router;
