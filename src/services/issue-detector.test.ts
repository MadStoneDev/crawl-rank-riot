import { describe, it, expect } from "vitest";
import { analyzePageIssues } from "./issue-detector";
import type { ScanResult } from "../types";

/** A healthy HTML page; override per test. */
function makeResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    url: "https://example.com/doc",
    depth: 0,
    status: 200,
    title: "A perfectly good page title about bookkeeping services",
    meta_description:
      "A perfectly adequate meta description that is long enough to satisfy the length checks applied by the issue detector here.",
    h1s: ["Main heading"],
    h2s: [],
    h3s: [],
    h4s: [],
    h5s: [],
    h6s: [],
    content_length: 1200,
    word_count: 400,
    open_graph: {},
    twitter_card: {},
    canonical_url: "https://example.com/doc",
    canonical_is_self: true,
    is_indexable: true,
    has_robots_noindex: false,
    has_robots_nofollow: false,
    internal_links: [],
    external_links: [],
    images: [],
    redirect_url: null,
    redirect_chain: [],
    content_type: "text/html",
    size_bytes: 1200,
    load_time_ms: 100,
    first_byte_time_ms: 50,
    security_headers: {},
    has_viewport_meta: true,
    has_mixed_content: false,
    structured_data: [],
    schema_types: [],
    js_count: 0,
    css_count: 0,
    keywords: [],
    heading_hierarchy_valid: true,
    heading_hierarchy_issues: [],
    hreflang_tags: [],
    url_issues: [],
    scan_method: "http",
    scanned_at: new Date().toISOString(),
    errors: [],
    warnings: [],
    ...over,
  } as ScanResult;
}

const types = (over: Partial<ScanResult>) =>
  analyzePageIssues(makeResult(over), "p", "pg", "sc").map((i) => i.issue_type);

describe("analyzePageIssues — non-HTML resources (S-02)", () => {
  it("raises NO page content issues for a non-HTML 2xx resource (e.g. a PDF)", () => {
    const issues = types({
      url: "https://example.com/brochure.pdf",
      content_type: "application/pdf",
      is_non_html: true,
      // Everything an HTML page needs is absent — would normally fire
      // missing_title / missing_h1 / missing_meta_description etc.
      title: "",
      meta_description: "",
      h1s: [],
    });
    expect(issues).toEqual([]);
  });

  it("STILL flags a broken non-HTML resource (404) as not_found", () => {
    const issues = types({
      url: "https://example.com/missing.pdf",
      status: 404,
      content_type: "",
      is_non_html: true,
    });
    expect(issues).toContain("not_found");
  });

  it("STILL flags a non-HTML 5xx as a server error", () => {
    const issues = types({
      url: "https://example.com/broken.json",
      status: 503,
      content_type: "application/json",
      is_non_html: true,
    });
    expect(issues).toContain("server_error");
  });

  it("control: an HTML page missing its title/H1 does fire those findings", () => {
    const issues = types({ title: "", h1s: [] });
    expect(issues).toContain("missing_title");
    expect(issues).toContain("missing_h1");
  });
});

describe("analyzePageIssues — temporary redirects (R-01)", () => {
  it("flags a page reached via a 302", () => {
    const issues = types({
      is_redirect: true,
      redirect_hops: [
        { from: "https://example.com/old", status: 302, to: "https://example.com/doc" },
      ],
    });
    expect(issues).toContain("temporary_redirect");
  });

  it("flags 303 and 307 too", () => {
    for (const status of [303, 307]) {
      const issues = types({
        is_redirect: true,
        redirect_hops: [{ from: "https://example.com/old", status, to: "https://example.com/doc" }],
      });
      expect(issues).toContain("temporary_redirect");
    }
  });

  it("does NOT flag a permanent 301/308 redirect", () => {
    for (const status of [301, 308]) {
      const issues = types({
        is_redirect: true,
        redirect_hops: [{ from: "https://example.com/old", status, to: "https://example.com/doc" }],
      });
      expect(issues).not.toContain("temporary_redirect");
    }
  });

  it("does NOT flag a page that was not redirected", () => {
    expect(types({})).not.toContain("temporary_redirect");
  });

  it("R-03/S-03: flags too_many_redirects when the budget was exhausted", () => {
    expect(types({ redirect_limit_hit: true })).toContain("too_many_redirects");
  });

  it("does NOT flag too_many_redirects normally", () => {
    expect(types({})).not.toContain("too_many_redirects");
  });
});

describe("analyzePageIssues — canonical & structured-data signals", () => {
  it("CN-01: flags multiple conflicting canonicals", () => {
    const issues = types({
      canonical_url: "https://example.com/a",
      canonical_is_self: false,
      canonical_urls: ["https://example.com/a", "https://example.com/b"],
    });
    expect(issues).toContain("multiple_canonical");
  });

  it("does NOT flag multiple_canonical when there is a single canonical", () => {
    const issues = types({
      canonical_url: "https://example.com/doc",
      canonical_is_self: true,
      canonical_urls: ["https://example.com/doc"],
    });
    expect(issues).not.toContain("multiple_canonical");
  });

  it("CN-03: a same-site non-self canonical is a canonical_mismatch", () => {
    const issues = types({
      canonical_url: "https://example.com/other",
      canonical_is_self: false,
    });
    expect(issues).toContain("canonical_mismatch");
    expect(issues).not.toContain("cross_domain_canonical");
  });

  it("CN-03: a cross-domain canonical is informational, not a mismatch", () => {
    const issues = types({
      canonical_url: "https://syndicator.com/doc",
      canonical_is_self: false,
    });
    expect(issues).toContain("cross_domain_canonical");
    expect(issues).not.toContain("canonical_mismatch");
  });

  it("P-03: flags malformed JSON-LD even when nothing parsed", () => {
    const issues = types({
      structured_data: [],
      has_invalid_structured_data: true,
    });
    expect(issues).toContain("invalid_structured_data");
  });
});

describe("analyzePageIssues — load-time method gating (PF-02)", () => {
  it("flags slow_page for an HTTP-timed page over the threshold", () => {
    expect(types({ scan_method: "http", load_time_ms: 4200 })).toContain("slow_page");
  });

  it("does NOT flag slow_page for a headless page (media blocked, not comparable)", () => {
    expect(types({ scan_method: "headless", load_time_ms: 4200 })).not.toContain("slow_page");
  });

  it("does NOT flag a fast HTTP page", () => {
    expect(types({ scan_method: "http", load_time_ms: 800 })).not.toContain("slow_page");
  });
});
