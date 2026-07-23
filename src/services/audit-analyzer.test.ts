import { describe, it, expect } from "vitest";
import { AuditAnalyzer } from "./audit-analyzer";
import { makeScanResult } from "../../test/fixtures/scan-result";
import { TechStackAnalysis } from "../types";

// analyzeTechStack is private but network-free; exercise it directly.
function techStackOf(page: Parameters<typeof makeScanResult>[0]): Promise<TechStackAnalysis> {
  const result = makeScanResult(page);
  const analyzer = new AuditAnalyzer([result], result.url);
  return (analyzer as any).analyzeTechStack();
}

describe("AuditAnalyzer tech-stack detection (from real asset URLs)", () => {
  it("detects Next.js (and React) from a real _next bundle path", async () => {
    const tech = await techStackOf({
      url: "https://shop.example.com/",
      script_srcs: ["https://shop.example.com/_next/static/chunks/main-9f2a.js"],
    });
    expect(tech.hasNextJs).toBe(true);
    expect(tech.hasReact).toBe(true);
    expect(tech.framework).toBe("Next.js");
  });

  it("detects WordPress from a wp-content script src", async () => {
    const tech = await techStackOf({
      url: "https://blog.example.com/",
      script_srcs: ["https://blog.example.com/wp-content/themes/x/app.js"],
    });
    expect(tech.hasWordPress).toBe(true);
    expect(tech.cms).toBe("WordPress");
  });

  it("detects jQuery from a real script src", async () => {
    const tech = await techStackOf({
      url: "https://example.com/",
      script_srcs: ["https://code.jquery.com/jquery-3.6.0.min.js"],
    });
    expect(tech.libraries).toContain("jQuery");
  });

  it("does NOT flag a framework for a plain static site", async () => {
    const tech = await techStackOf({
      url: "https://static.example.com/",
      script_srcs: ["https://static.example.com/js/site.js"],
    });
    expect(tech.hasReact).toBe(false);
    expect(tech.hasVue).toBe(false);
    expect(tech.hasNextJs).toBe(false);
    expect(tech.framework).toBeUndefined();
  });

  it("regression: anchor-href .js links no longer fake a framework", async () => {
    // Before the fix, scripts were inferred from anchor hrefs, so a link to a
    // page ending in .js (or containing _next/) could produce a false verdict.
    // With no real script_srcs, nothing should be detected.
    const tech = await techStackOf({
      url: "https://example.com/",
      script_srcs: [],
      internal_links: [
        { url: "https://example.com/guides/_next/how-to.js", anchor_text: "guide", rel_attributes: [] },
      ],
      external_links: [
        { url: "https://cdn.example.com/downloads/react-tutorial.js", anchor_text: "tut", rel_attributes: [] },
      ],
    });
    expect(tech.hasNextJs).toBe(false);
    expect(tech.hasReact).toBe(false);
    expect(tech.framework).toBeUndefined();
  });
});
