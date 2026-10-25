import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  hasScope,
  type ApiKeyStore,
  type ApiKeyRecord,
} from "./keys";

// A single-record store: returns `record` for any prefix lookup (verification
// still enforces the constant-time hash comparison on top).
function fakeStore(record: ApiKeyRecord | null): ApiKeyStore & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    async findByPrefix() {
      return record;
    },
    async touchLastUsed(id) {
      touched.push(id);
    },
  };
}

function recordFor(key: string, over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: "key_1",
    user_id: "user_1",
    key_hash: hashApiKey(key),
    scopes: ["jobs:read", "jobs:write"],
    rate_limit_per_min: 60,
    monthly_quota: null,
    status: "active",
    ...over,
  };
}

describe("key minting + hashing", () => {
  it("mints an rrk_ key whose prefix and hash match the helpers", () => {
    const { key, prefix, hash } = generateApiKey("live");
    expect(key.startsWith("rrk_live_")).toBe(true);
    expect(prefix).toBe(key.slice(0, 16));
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints distinct keys", () => {
    expect(generateApiKey().key).not.toBe(generateApiKey().key);
  });
});

describe("verifyApiKey", () => {
  it("accepts a well-formed, active key with a matching hash and stamps last-used", async () => {
    const { key } = generateApiKey();
    const store = fakeStore(recordFor(key));
    const res = await verifyApiKey(key, store);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.user_id).toBe("user_1");
    // last-used stamp is fire-and-forget; allow the microtask to run.
    await Promise.resolve();
    expect(store.touched).toContain("key_1");
  });

  it("rejects a malformed key without touching the store", async () => {
    const store = fakeStore(recordFor("rrk_live_whatever"));
    expect(await verifyApiKey("nope", store)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyApiKey(undefined, store)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects when no row matches the prefix", async () => {
    const res = await verifyApiKey(generateApiKey().key, fakeStore(null));
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects a prefix hit whose hash does not match (as not_found)", async () => {
    const stored = generateApiKey().key;
    const presented = generateApiKey().key; // different secret, same shape
    const res = await verifyApiKey(presented, fakeStore(recordFor(stored)));
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects a revoked key even with a matching hash", async () => {
    const { key } = generateApiKey();
    const res = await verifyApiKey(key, fakeStore(recordFor(key, { status: "revoked" })));
    expect(res).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("hasScope", () => {
  it("checks membership", () => {
    const rec = recordFor(generateApiKey().key, { scopes: ["jobs:read"] });
    expect(hasScope(rec, "jobs:read")).toBe(true);
    expect(hasScope(rec, "jobs:write")).toBe(false);
  });
});
