// Scoped API keys for the /api/v1 jobs API (Stage 3).
//
// A key is `rrk_<env>_<random>`. We store only its SHA-256 hash plus a
// non-secret 16-char prefix (indexed for lookup). Verification finds the row by
// prefix, then does a constant-time hash comparison — so a stored hash leak
// does not reveal usable keys and lookup stays O(1).
//
// The DB-coupled part is behind an ApiKeyStore port (default: the Supabase
// service client) so the crypto/scope/quota logic is unit-testable without a DB.

import crypto from "crypto";
import { v1Db } from "./db";

export type ApiScope = "jobs:read" | "jobs:write";
export const API_SCOPES: ApiScope[] = ["jobs:read", "jobs:write"];

const PREFIX_LEN = 16;

export interface ApiKeyRecord {
  id: string;
  user_id: string;
  key_hash: string;
  scopes: string[];
  rate_limit_per_min: number;
  monthly_quota: number | null;
  status: string; // 'active' | 'revoked'
}

/** The DB operations key verification needs. */
export interface ApiKeyStore {
  findByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  touchLastUsed(id: string): Promise<void>;
}

/** SHA-256 hex of the full key. */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

/** The indexed, non-secret lookup prefix (first 16 chars). */
export function extractPrefix(key: string): string {
  return key.slice(0, PREFIX_LEN);
}

/**
 * Mint a new key. Returns the full key (show once), its prefix and its hash to
 * persist. 32 random bytes → 43 base64url chars of entropy.
 */
export function generateApiKey(env: "live" | "test" = "live"): {
  key: string;
  prefix: string;
  hash: string;
} {
  const random = crypto.randomBytes(32).toString("base64url");
  const key = `rrk_${env}_${random}`;
  return { key, prefix: extractPrefix(key), hash: hashApiKey(key) };
}

/** Constant-time comparison of two hex digests of equal length. */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function hasScope(record: ApiKeyRecord, scope: ApiScope): boolean {
  return record.scopes.includes(scope);
}

export type VerifyResult =
  | { ok: true; record: ApiKeyRecord }
  | { ok: false; reason: "malformed" | "not_found" | "revoked" };

/**
 * Verify a presented key. Pure given the store, so tests inject a fake store.
 */
export async function verifyApiKey(
  presentedKey: string | undefined | null,
  store: ApiKeyStore = supabaseApiKeyStore(),
): Promise<VerifyResult> {
  if (!presentedKey || !presentedKey.startsWith("rrk_") || presentedKey.length < PREFIX_LEN + 8) {
    return { ok: false, reason: "malformed" };
  }
  const record = await store.findByPrefix(extractPrefix(presentedKey));
  if (!record) return { ok: false, reason: "not_found" };
  // Compare hashes even when revoked, to keep timing uniform, then reject.
  const match = hashesEqual(hashApiKey(presentedKey), record.key_hash);
  if (!match) return { ok: false, reason: "not_found" };
  if (record.status !== "active") return { ok: false, reason: "revoked" };
  // Best-effort last-used stamp; never block the request on it.
  store.touchLastUsed(record.id).catch(() => {});
  return { ok: true, record };
}

/** Default store backed by the Supabase service-role client. */
export function supabaseApiKeyStore(): ApiKeyStore {
  return {
    async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
      const { data, error } = await v1Db()
        .from("api_keys")
        .select("id, user_id, key_hash, scopes, rate_limit_per_min, monthly_quota, status")
        .eq("key_prefix", prefix)
        .maybeSingle();
      if (error || !data) return null;
      return data as ApiKeyRecord;
    },
    async touchLastUsed(id: string): Promise<void> {
      await v1Db()
        .from("api_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", id);
    },
  };
}
