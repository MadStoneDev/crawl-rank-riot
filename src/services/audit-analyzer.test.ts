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

// analyzeDesign is private and network-free; exercise it directly.
function designOf(page: Parameters<typeof makeScanResult>[0]): Promise<any> {
  const result = makeScanResult(page);
  const analyzer = new AuditAnalyzer([result], result.url);
  return (analyzer as any).analyzeDesign();
}

describe("AuditAnalyzer design analysis (honest signals only)", () => {
  it("extracts real Google Font families from stylesheet hrefs", async () => {
    const design = await designOf({
      url: "https://example.com/",
      stylesheet_hrefs: [
        "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Roboto+Mono&display=swap",
      ],
    });
    expect(design.fonts).toContain("Inter");
    expect(design.fonts).toContain("Roboto Mono");
  });

  it("detects social platforms from external link hostnames, not substrings", async () => {
    const design = await designOf({
      url: "https://example.com/",
      external_links: [
        { url: "https://www.instagram.com/acme", anchor_text: "IG", rel_attributes: [] },
        { url: "https://x.com/acme", anchor_text: "X", rel_attributes: [] },
      ],
    });
    expect(design.hasSocialLinks).toBe(true);
    expect(design.socialPlatforms).toContain("instagram");
    expect(design.socialPlatforms).toContain("X (Twitter)");
    expect(design.score).toBe(100); // has social -> no penalty
  });

  it("does not false-positive social from a non-link mention", async () => {
    // 'twitter.com' appearing only in meta/text must NOT count — only real
    // external links do. Here there are no external links at all.
    const design = await designOf({
      url: "https://example.com/",
      meta_description: "Follow us on twitter.com/acme for updates",
      external_links: [],
    });
    expect(design.hasSocialLinks).toBe(false);
    expect(design.score).toBe(90); // -10 for no social links
  });

  it("no longer reports colours or a copyright year", async () => {
    const design = await designOf({ url: "https://example.com/" });
    expect(design.colors).toBeUndefined();
    expect(design.copyrightYear).toBeUndefined();
  });
});
