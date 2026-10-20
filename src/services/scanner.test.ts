import { describe, it, expect } from "vitest";
import { needsHeadlessEscalation } from "./scanner";

const html = (over: Partial<Parameters<typeof needsHeadlessEscalation>[0]> = {}) => ({
  title: "A real page title",
  content_type: "text/html; charset=utf-8",
  content_length: 5000,
  word_count: 600,
  ...over,
});

describe("needsHeadlessEscalation (J-01)", () => {
  it("escalates when there is no title", () => {
    expect(needsHeadlessEscalation(html({ title: "" }), null)).toBe(true);
  });

  it("escalates a near-empty HTTP body regardless of platform", () => {
    expect(
      needsHeadlessEscalation(html({ content_length: 120, word_count: 2 }), null),
    ).toBe(true);
  });

  it("does NOT escalate a content-rich page on a non-SPA platform", () => {
    expect(needsHeadlessEscalation(html({ word_count: 600 }), "wordpress")).toBe(false);
    expect(needsHeadlessEscalation(html({ word_count: 600 }), null)).toBe(false);
  });

  it("J-01: escalates a SPA shell that clears the thin-content bar (nav + cookie banner)", () => {
    // 40 words of nav/cookie text — passes the <5 word check but is a shell.
    expect(needsHeadlessEscalation(html({ word_count: 40 }), "shopify")).toBe(true);
    expect(needsHeadlessEscalation(html({ word_count: 40 }), "spa-generic")).toBe(true);
    expect(needsHeadlessEscalation(html({ word_count: 40 }), "react-spa")).toBe(true);
  });

  it("does NOT escalate a client-rendered platform that already returned substantial content", () => {
    expect(needsHeadlessEscalation(html({ word_count: 600 }), "shopify")).toBe(false);
  });
});
