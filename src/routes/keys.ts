import { Router, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { getSupabaseServiceClient } from "../services/database/client";
import {
  generateApiKey,
  API_SCOPES,
  type ApiScope,
} from "../services/api/v1/keys";
import { getCurrentUsage } from "../services/api/v1/usage";

// User-facing API-key management for the app's "API keys" settings screen.
// Minting reuses generateApiKey() from the v1 keys module (the same logic the
// CLI uses) — nothing is duplicated. Keys live in api_keys, which is service-
// role-only (RLS + revoked grants), so these endpoints run on the service
// client but always scope by the authenticated user (req.user, set by the JWT
// authMiddleware the router is mounted behind). Normal users get default limits;
// an admin adjusts rate/quota from the admin area (not here).
const router = Router();

const DEFAULT_RATE_LIMIT_PER_MIN = 60;

/** Default monthly_quota for a user-created key. null = unlimited. */
const DEFAULT_MONTHLY_QUOTA: number | null = null;

export interface ParsedCreateInput {
  name: string;
  scopes: ApiScope[];
}

/**
 * Validate and normalise the create-key request body. Pure, so it is
 * unit-tested without a DB. A key needs a non-empty label and at least one
 * valid scope from API_SCOPES.
 */
export function parseCreateKeyInput(
  body: unknown,
): { ok: true; value: ParsedCreateInput } | { ok: false; error: string } {
  const b = (body ?? {}) as { name?: unknown; scopes?: unknown };
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return { ok: false, error: "A label is required." };
  if (name.length > 100) return { ok: false, error: "Label is too long (max 100 characters)." };

  if (!Array.isArray(b.scopes)) {
    return { ok: false, error: "scopes must be an array." };
  }
  const scopes = Array.from(new Set(b.scopes.map((s) => String(s))));
  const invalid = scopes.filter((s) => !(API_SCOPES as string[]).includes(s));
  if (invalid.length) {
    return {
      ok: false,
      error: `Unknown scope(s): ${invalid.join(", ")}. Valid: ${API_SCOPES.join(", ")}.`,
    };
  }
  if (scopes.length === 0) return { ok: false, error: "Select at least one scope." };

  return { ok: true, value: { name, scopes: scopes as ApiScope[] } };
}

/** Caller's gate: api_access flag plus admin role, from profiles. */
async function loadAccess(
  userId: string,
): Promise<{ apiAccess: boolean; isAdmin: boolean }> {
  const { data } = await getSupabaseServiceClient()
    .from("profiles")
    .select("role, api_access")
    .eq("id", userId)
    .maybeSingle();
  const row = (data ?? {}) as { role?: string | null; api_access?: boolean | null };
  return { apiAccess: row.api_access === true, isAdmin: row.role === "admin" };
}

// GET /api/keys — the authenticated user's own keys, with this month's usage.
// Never returns key_hash.
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const supabase = getSupabaseServiceClient();
  const { data, error } = await supabase
    .from("api_keys")
    .select(
      "id, name, key_prefix, scopes, rate_limit_per_min, monthly_quota, status, created_at, last_used_at, revoked_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("GET /api/keys list error:", error);
    res.status(500).json({ error: "database_error" });
    return;
  }

  const keys = await Promise.all(
    (data ?? []).map(async (k) => {
      const { usage } = await getCurrentUsage(k.id);
      return { ...k, usage };
    }),
  );
  res.json({ keys });
});

// POST /api/keys — create a key for the authenticated user. Gated by api_access
// (or admin). The raw key is returned ONCE; only prefix + hash are stored.
// Normal users get default limits; admins tune rate/quota from the admin area.
router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { apiAccess, isAdmin } = await loadAccess(userId);
  if (!apiAccess && !isAdmin) {
    res.status(403).json({ error: "api_access_required" });
    return;
  }

  const parsed = parseCreateKeyInput(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_request", message: parsed.error });
    return;
  }

  const { key, prefix, hash } = generateApiKey("live");
  const supabase = getSupabaseServiceClient();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      user_id: userId,
      name: parsed.value.name,
      key_prefix: prefix,
      key_hash: hash,
      scopes: parsed.value.scopes,
      rate_limit_per_min: DEFAULT_RATE_LIMIT_PER_MIN,
      monthly_quota: DEFAULT_MONTHLY_QUOTA,
      status: "active",
    })
    .select(
      "id, name, key_prefix, scopes, rate_limit_per_min, monthly_quota, status, created_at, last_used_at, revoked_at",
    )
    .single();
  if (error || !data) {
    console.error("POST /api/keys create error:", error);
    res.status(500).json({ error: "database_error" });
    return;
  }

  // The raw key is shown exactly once. The client must surface it and warn that
  // it cannot be recovered.
  res.status(201).json({ key, record: { ...data, usage: { requests: 0, jobs_created: 0 } } });
});

// POST /api/keys/:id/revoke — revoke one of the caller's own keys. Revoked keys
// are kept (listed as revoked), never hard-deleted, and can no longer
// authenticate.
router.post("/:id/revoke", async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const id = req.params.id;
  const supabase = getSupabaseServiceClient();
  const { data, error } = await supabase
    .from("api_keys")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId) // ownership: a user can only revoke their own keys
    .select("id, key_prefix, status, revoked_at")
    .maybeSingle();
  if (error) {
    console.error("POST /api/keys/:id/revoke error:", error);
    res.status(500).json({ error: "database_error" });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ record: data });
});

export default router;
