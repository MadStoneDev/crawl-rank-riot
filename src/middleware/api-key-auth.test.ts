import { describe, it, expect, vi } from "vitest";
import { requireScope, ApiKeyRequest } from "./api-key-auth";
import type { ApiKeyRecord } from "../services/api/v1/keys";
import type { Response } from "express";

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any };
}

const key: ApiKeyRecord = {
  id: "key_1",
  user_id: "user_1",
  key_hash: "x",
  scopes: ["jobs:read"],
  rate_limit_per_min: 60,
  monthly_quota: null,
  status: "active",
};

describe("requireScope", () => {
  it("calls next() when the key has the scope", () => {
    const res = fakeRes();
    const next = vi.fn();
    requireScope("jobs:read")({ apiKey: key } as ApiKeyRequest, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it("403s with insufficient_scope when the scope is missing", () => {
    const res = fakeRes();
    const next = vi.fn();
    requireScope("jobs:write")({ apiKey: key } as ApiKeyRequest, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("insufficient_scope");
    expect(res.body.error.details.required_scope).toBe("jobs:write");
  });

  it("401s when no key is attached", () => {
    const res = fakeRes();
    const next = vi.fn();
    requireScope("jobs:read")({} as ApiKeyRequest, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
  });

  it("wraps errors in the versioned v1 envelope", () => {
    const res = fakeRes();
    requireScope("jobs:write")({ apiKey: key } as ApiKeyRequest, res, vi.fn());
    expect(res.body.api_version).toBe("v1");
    expect(res.body.schema_version).toBeDefined();
  });
});
