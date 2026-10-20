import { describe, it, expect } from "vitest";
import { effectiveConcurrency } from "./crawler";

describe("effectiveConcurrency (PL-02)", () => {
  it("serialises (cap 1) when the host declares a Crawl-delay", () => {
    expect(effectiveConcurrency(3, 1000)).toBe(1);
    expect(effectiveConcurrency(10, 10_000)).toBe(1);
  });

  it("uses the configured concurrency when there is no Crawl-delay", () => {
    expect(effectiveConcurrency(3, 0)).toBe(3);
    expect(effectiveConcurrency(10, 0)).toBe(10);
  });

  it("never drops below 1", () => {
    expect(effectiveConcurrency(0, 0)).toBe(1);
  });
});
