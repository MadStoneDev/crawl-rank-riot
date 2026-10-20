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
