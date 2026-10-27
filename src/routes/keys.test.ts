import { describe, it, expect } from "vitest";
import { parseCreateKeyInput } from "./keys";

describe("parseCreateKeyInput", () => {
  it("accepts a valid label + scopes", () => {
    const r = parseCreateKeyInput({ name: "My key", scopes: ["jobs:read", "jobs:write"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("My key");
      expect(r.value.scopes).toEqual(["jobs:read", "jobs:write"]);
    }
  });

  it("trims the label and dedupes scopes", () => {
    const r = parseCreateKeyInput({ name: "  Trimmed  ", scopes: ["jobs:read", "jobs:read"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Trimmed");
      expect(r.value.scopes).toEqual(["jobs:read"]);
    }
  });

  it("rejects a missing or empty label", () => {
    expect(parseCreateKeyInput({ scopes: ["jobs:read"] }).ok).toBe(false);
    expect(parseCreateKeyInput({ name: "   ", scopes: ["jobs:read"] }).ok).toBe(false);
  });

  it("rejects a label over 100 chars", () => {
    const r = parseCreateKeyInput({ name: "x".repeat(101), scopes: ["jobs:read"] });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown scope", () => {
    const r = parseCreateKeyInput({ name: "k", scopes: ["jobs:read", "admin:all"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/admin:all/);
  });

  it("rejects when scopes is not an array", () => {
    expect(parseCreateKeyInput({ name: "k", scopes: "jobs:read" }).ok).toBe(false);
  });

  it("rejects an empty scope list", () => {
    expect(parseCreateKeyInput({ name: "k", scopes: [] }).ok).toBe(false);
  });
});
