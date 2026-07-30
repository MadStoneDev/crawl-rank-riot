import { ScanResult } from "../../src/types";

/**
 * Build a ScanResult for tests. Defaults are a deliberately "empty/failing"
 * baseline (200 OK but no title, no meta, no content, not indexable, no images)
 * so each test states exactly the signals it provides via `overrides`. This
 * keeps scoring assertions readable and makes it obvious which field drives a
 * given number.
 */
export function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    url: "https://example.com/",
    status: 200,
    depth: 0,

    h1s: [],
    h2s: [],
    h3s: [],
    h4s: [],
    h5s: [],
    h6s: [],
    content_length: 0,
    word_count: 0,

    canonical_url: null,
    is_indexable: false,
    has_robots_noindex: false,
    has_robots_nofollow: false,
    open_graph: {},
    twitter_card: {},

    internal_links: [],
    external_links: [],
    images: [],

    redirect_url: null,
    content_type: "text/html",
    size_bytes: 0,
    load_time_ms: 0,
    first_byte_time_ms: 0,

    structured_data: [],
    schema_types: [],

    js_count: 0,
    css_count: 0,

    keywords: [],
    scanned_at: "2026-07-20T00:00:00.000Z",

    ...overrides,
  };
}

/** A page that passes every signal computeSeoScore looks at. */
export function makeOptimizedPage(overrides: Partial<ScanResult> = {}): ScanResult {
  return makeScanResult({
    status: 200,
    is_indexable: true,
    load_time_ms: 500,
    title: "A clear, descriptive page title",
    meta_description: "A concise meta description that summarizes the page.",
    word_count: 800,
    h1s: ["Main heading"],
    open_graph: { "og:title": "A clear, descriptive page title" },
    structured_data: [{ "@type": "Article" }],
    schema_types: ["Article"],
    images: [{ src: "https://example.com/a.png", alt: "Descriptive alt text" }],
    ...overrides,
  });
}
