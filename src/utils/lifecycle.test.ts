import { describe, it, expect, beforeEach } from "vitest";
import { isShuttingDown, beginShutdown, __resetShutdownForTests } from "./lifecycle";

describe("lifecycle shutdown flag", () => {
  beforeEach(() => __resetShutdownForTests());

  it("is not shutting down by default", () => {
    expect(isShuttingDown()).toBe(false);
  });

  it("flips to true after beginShutdown()", () => {
    beginShutdown();
    expect(isShuttingDown()).toBe(true);
  });

  it("is idempotent — a second beginShutdown() stays true", () => {
    beginShutdown();
    beginShutdown();
    expect(isShuttingDown()).toBe(true);
  });
});
