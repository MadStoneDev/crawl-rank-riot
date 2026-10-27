import { describe, it, expect } from "vitest";
import {
  analyzePageIssues,
  detectInternalLinkingIssues,
} from "./issue-detector";
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

  it("PF-03: flags large_page_size only for HTTP-timed pages", () => {
    const big = 4 * 1024 * 1024;
    expect(types({ scan_method: "http", size_bytes: big })).toContain("large_page_size");
    expect(types({ scan_method: "headless", size_bytes: big })).not.toContain("large_page_size");
  });
});

// The poor_readability threshold (< 30 Flesch, > 100 words) is applied to the
// MAIN-CONTENT readability score. Both scan paths now compute that score the same
// way (shared parser), so the rule can't fire differently by scan path. These
// pin the boundary so a future change to how readability is measured can't
// silently move the rule. See docs/audit/09-headless-mapping.md.
describe("analyzePageIssues — poor_readability threshold", () => {
  it("fires below 30 with substantial content (the headless-aligned WordPress case)", () => {
    // Headless now yields a main-content Flesch of ~18 where the old whole-body
    // measure read ~30; both are judged against the same bar the HTTP path uses.
    expect(types({ readability_score: 18, word_count: 370 })).toContain("poor_readability");
  });

  it("does NOT fire at exactly 30 (bar is strict '< 30')", () => {
    expect(types({ readability_score: 30, word_count: 370 })).not.toContain("poor_readability");
  });

  it("does NOT fire on thin content even when readability is very low (word_count guard)", () => {
    expect(types({ readability_score: 10, word_count: 100 })).not.toContain("poor_readability");
    expect(types({ readability_score: 10, word_count: 101 })).toContain("poor_readability");
  });

  it("does NOT fire when readability_score is undefined", () => {
    expect(types({ readability_score: undefined, word_count: 370 })).not.toContain("poor_readability");
  });
});

describe("analyzePageIssues — deep_page (F-D12)", () => {
  it("fires on an indexable content page at depth 4", () => {
    expect(types({ depth: 4 })).toContain("deep_page");
  });

  it("does NOT fire at depth 3 (recommended max is 3)", () => {
    expect(types({ depth: 3 })).not.toContain("deep_page");
  });

  it("does NOT fire on a deep noindex page", () => {
    expect(
      types({ depth: 6, has_robots_noindex: true }),
    ).not.toContain("deep_page");
    expect(types({ depth: 6, is_indexable: false })).not.toContain("deep_page");
  });

  it("does NOT fire on a deep non-content page (tag/pagination/archive)", () => {
    expect(
      types({ url: "https://example.com/tag/news", depth: 6 }),
    ).not.toContain("deep_page");
    expect(
      types({ url: "https://example.com/page/5", depth: 6 }),
    ).not.toContain("deep_page");
  });

  it("records the depth in details", () => {
    const issues = analyzePageIssues(
      makeResult({ depth: 5 }),
      "p",
      "pg",
      "sc",
    );
    const deep = issues.find((i) => i.issue_type === "deep_page");
    expect(deep?.details).toMatchObject({ depth: 5 });
  });
});

describe("detectInternalLinkingIssues — orphan vs weak (F-D12)", () => {
  // Run internal-linking detection over a set of pages with explicit inbound
  // counts. Pages default to a depth-1 indexable content page.
  function linkIssues(
    pages: {
      url: string;
      id: string;
      inbound: number;
      over?: Partial<ScanResult>;
    }[],
    variants: string[] = [],
  ) {
    const results = pages.map((p) =>
      makeResult({ url: p.url, depth: 1, ...p.over }),
    );
    const pageIdMap = new Map(pages.map((p) => [p.url, p.id]));
    const inboundCount = new Map(pages.map((p) => [p.id, p.inbound]));
    return detectInternalLinkingIssues(
      results,
      inboundCount,
      pageIdMap,
      new Set(variants),
      "p",
      "sc",
    );
  }

  const typesFor = (
    pages: Parameters<typeof linkIssues>[0],
    variants: string[] = [],
  ) => linkIssues(pages, variants).map((i) => i.issue_type);

  it("flags a content page with 0 inbound links as orphan_page, not weak", () => {
    const types = typesFor([
      { url: "https://example.com/a", id: "a", inbound: 0 },
    ]);
    expect(types).toContain("orphan_page");
    expect(types).not.toContain("weak_internal_linking");
  });

  it("flags 1 and 2 inbound links as weak_internal_linking, not orphan", () => {
    for (const inbound of [1, 2]) {
      const types = typesFor([
        { url: "https://example.com/a", id: "a", inbound },
      ]);
      expect(types).toContain("weak_internal_linking");
      expect(types).not.toContain("orphan_page");
    }
  });

  it("does NOT flag a page with 3+ inbound links", () => {
    expect(
      typesFor([{ url: "https://example.com/a", id: "a", inbound: 3 }]),
    ).toEqual([]);
  });

  it("excludes the home page (depth 0) even with 0 inbound", () => {
    expect(
      typesFor([
        { url: "https://example.com/", id: "home", inbound: 0, over: { depth: 0 } },
      ]),
    ).toEqual([]);
  });

  it("excludes non-content pages (tag/pagination)", () => {
    expect(
      typesFor([
        { url: "https://example.com/tag/x", id: "t", inbound: 0 },
        { url: "https://example.com/page/2", id: "pg2", inbound: 1 },
      ]),
    ).toEqual([]);
  });

  it("excludes canonicalised variants", () => {
    expect(
      typesFor(
        [{ url: "https://example.com/quote?x=1", id: "v", inbound: 0 }],
        ["https://example.com/quote?x=1"],
      ),
    ).toEqual([]);
  });

  it("does NOT flag weak_internal_linking on a noindex or non-indexable page", () => {
    expect(
      typesFor([
        {
          url: "https://example.com/a",
          id: "a",
          inbound: 2,
          over: { has_robots_noindex: true },
        },
      ]),
    ).toEqual([]);
    expect(
      typesFor([
        {
          url: "https://example.com/b",
          id: "b",
          inbound: 2,
          over: { is_indexable: false },
        },
      ]),
    ).toEqual([]);
  });

  it("records the inbound count in details", () => {
    const orphan = linkIssues([
      { url: "https://example.com/a", id: "a", inbound: 0 },
    ])[0];
    expect(orphan.details).toMatchObject({ inbound_links: 0 });
    const weak = linkIssues([
      { url: "https://example.com/b", id: "b", inbound: 2 },
    ])[0];
    expect(weak.details).toMatchObject({ inbound_links: 2 });
  });
});
