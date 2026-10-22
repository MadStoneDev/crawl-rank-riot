/**
 * Generate recorded /api/v1 response samples for docs/api/samples/.
 *
 * Runs the REAL scoring (computeScoreReport + computeWeightedScore, exactly as
 * seoStrategy does) and the REAL v1 serializers over a small, internally
 * consistent dataset, so the committed JSON is what the API actually emits.
 *
 * `buildSamples()` is pure (name -> file contents) so a test can assert the
 * committed files are up to date; running this file writes them:
 *
 *   npx ts-node src/scripts/generate-v1-samples.ts
 */

import fs from "fs";
import path from "path";
import { computeScoreReport } from "../scoring/score-report";
import { computeWeightedScore, IssueAggregate } from "../scoring/weighted-score";
import { ScanResult } from "../types";
import { API_VERSION, SCHEMA_VERSION } from "../services/api/v1/version";
import {
  serializeJob,
  serializeReport,
  serializeIssue,
  serializeUsage,
  serializeProject,
  serializePageData,
  serializePageListItem,
  serializePageDetail,
  type IssueRow,
  type JobPageRow,
} from "../services/api/v1/serializers";
import { fingerprintTech } from "../services/extract/tech-fingerprint";
import { extractBusinessInfo } from "../services/extract/business-info";

/** The committed sample directory (in-repo, under docs/api/). */
export const SAMPLES_DIR = path.resolve(__dirname, "../../docs/api/samples");

function page(overrides: Partial<ScanResult>): ScanResult {
  return {
    url: "https://example.com/",
    status: 200,
    depth: 0,
    h1s: [], h2s: [], h3s: [], h4s: [], h5s: [], h6s: [],
    content_length: 0,
    word_count: 0,
    canonical_url: null,
    is_indexable: true,
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
    load_time_ms: 800,
    first_byte_time_ms: 200,
    structured_data: [],
    schema_types: [],
    js_count: 0,
    css_count: 0,
    keywords: [],
    scanned_at: "2026-10-22T00:00:00.000Z",
    ...overrides,
  };
}

const JOB_ID = "3f1c9a2e-7b84-4d2a-9f1e-0a2b3c4d5e6f";

function envelope<T>(data: T) {
  return { api_version: API_VERSION, schema_version: SCHEMA_VERSION, data };
}

/**
 * Build every sample as {filename -> file contents}. Pure: same inputs in, same
 * bytes out (the generator and the freshness test share this).
 */
export function buildSamples(): Record<string, string> {
  // A small, realistic crawl: one strong page, one thin page missing meta, one
  // slow post missing alt text.
  const results: ScanResult[] = [
    page({
      url: "https://example.com/",
      title: "Acme — industrial widgets",
      meta_description: "Acme makes durable industrial widgets for manufacturing lines.",
      word_count: 900,
      h1s: ["Industrial widgets built to last"],
      open_graph: { "og:title": "Acme" },
      structured_data: [{ "@type": "Organization" }],
      schema_types: ["Organization"],
      images: [{ src: "https://example.com/hero.webp", alt: "A widget" }],
    }),
    page({
      url: "https://example.com/about",
      title: "About",
      meta_description: "",
      word_count: 120,
      h1s: ["About Acme"],
    }),
    page({
      url: "https://example.com/blog/choosing-widgets",
      title: "Choosing the right widget",
      meta_description: "How to choose a widget.",
      word_count: 650,
      load_time_ms: 4200,
      h1s: ["Choosing the right widget"],
      images: [{ src: "https://example.com/post.jpg", alt: "" }],
    }),
  ];

  // The open issues this crawl would raise — a spread across all four
  // categories plus the speed tag — as they are stored in the issues table.
  const issueRows: Array<IssueRow & { severity: string }> = [
    { issue_type: "missing_meta_description", severity: "high", description: "No meta description.", page_url: "https://example.com/about" },
    { issue_type: "thin_content", severity: "medium", description: "Only 120 words.", page_url: "https://example.com/about" },
    { issue_type: "missing_image_alt", severity: "low", description: "1 image missing alt text.", page_url: "https://example.com/blog/choosing-widgets" },
    { issue_type: "slow_page", severity: "high", description: "Loaded in 4.2s (target 3s).", page_url: "https://example.com/blog/choosing-widgets" },
    { issue_type: "missing_twitter_card", severity: "low", description: "No Twitter Card tags.", page_url: "https://example.com/" },
  ];

  // Mirror seoStrategy: base report, then the weighted overlay for overall /
  // category scores + the deduction breakdown.
  const report = computeScoreReport(results, { blocked: false });
  const aggByType = new Map<string, { severity: IssueAggregate["severity"]; pages: Set<string> }>();
  const rank = { critical: 3, high: 2, medium: 1, low: 0 } as const;
  for (const r of issueRows) {
    const sev = r.severity as IssueAggregate["severity"];
    const e = aggByType.get(r.issue_type) ?? { severity: sev, pages: new Set<string>() };
    if (rank[sev] > rank[e.severity]) e.severity = sev;
    if (r.page_url) e.pages.add(r.page_url);
    aggByType.set(r.issue_type, e);
  }
  const aggregates: IssueAggregate[] = [...aggByType].map(([issueType, v]) => ({
    issueType,
    severity: v.severity,
    affectedPages: v.pages.size,
  }));
  const weighted = computeWeightedScore(aggregates, results.length);
  report.overall = weighted.overall;
  report.categories.technical.score = weighted.categories.technical;
  report.categories.content.score = weighted.categories.content;
  report.categories.media.score = weighted.categories.media;
  report.categories.aeo.score = weighted.categories.aeo;
  report.capped = weighted.capped;
  report.deductions = weighted.deductions;
  report.scoreModel = "weighted-v1";

  const bodies: Record<string, unknown> = {
    "job.json": envelope(
      serializeJob(
        { id: JOB_ID, type: "seo", project_id: "9c8b7a65-4321-4a1b-8c7d-6e5f4a3b2c1d", created_at: "2026-10-22T09:00:00.000Z" },
        {
          status: "completed",
          started_at: "2026-10-22T09:00:01.000Z",
          completed_at: "2026-10-22T09:03:12.000Z",
          pages_scanned: results.length,
          links_scanned: 48,
          issues_found: issueRows.length,
          failure_reason: null,
        },
      ),
    ),
    "report.json": envelope(serializeReport(JOB_ID, report)),
    "issues.json": envelope({
      object: "list",
      job_id: JOB_ID,
      items: issueRows.map(serializeIssue),
      page: { limit: 50, offset: 0, total: issueRows.length, has_more: false },
    }),
    "usage.json": envelope(serializeUsage("2026-10-01", 1284, 37, 500)),
  };

  // --- Stage 4 samples -----------------------------------------------------

  // A project managed through the API.
  bodies["project.json"] = envelope(
    serializeProject(
      { id: "7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d", name: "Acme Bookkeeping", url: "https://acme.test/", created_at: "2026-10-24T09:00:00.000Z" },
      { external_ref: "crm-42", metadata: { team: "growth" } },
    ),
  );

  // A page-scope job that ran only extraction modules (no scoring).
  bodies["job_page_scope.json"] = envelope(
    serializeJob(
      {
        id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
        type: "seo",
        project_id: "7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
        created_at: "2026-10-24T10:00:00.000Z",
        scope: "page",
        modules: ["fetch_extract", "tech_fingerprint", "business_info"],
        external_ref: "crm-42",
        metadata: { campaign: "q4-audit" },
      },
      {
        status: "completed",
        started_at: "2026-10-24T10:00:01.000Z",
        completed_at: "2026-10-24T10:00:06.000Z",
        pages_scanned: 1,
        links_scanned: 7,
        issues_found: 0,
        failure_reason: null,
      },
    ),
  );

  // A representative extracted page (real serializer + extractor output), used
  // for both the pages list and the page detail.
  const contactPage: ScanResult = page({
    url: "https://acme.test/contact",
    title: "Contact — Acme Bookkeeping",
    meta_description: "Call or visit Acme Bookkeeping in Sydney.",
    word_count: 180,
    h1s: ["Contact us"],
    open_graph: { "og:site_name": "Acme Bookkeeping" },
    script_srcs: [
      "https://www.googletagmanager.com/gtag/js?id=G-XXXX",
      "https://assets.calendly.com/assets/external/widget.js",
    ],
    external_links: [
      { url: "https://facebook.com/acmebookkeeping", anchor_text: "Facebook", rel_attributes: [] },
    ],
    contact_links: [
      { type: "tel", value: "+61 2 1234 5678", href: "tel:+61212345678" },
      { type: "email", value: "hello@acme.test", href: "mailto:hello@acme.test" },
    ],
    structured_data: [
      {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        name: "Acme Bookkeeping",
        telephone: "+61 2 1234 5678",
        address: {
          "@type": "PostalAddress",
          streetAddress: "1 Main St",
          addressLocality: "Sydney",
          addressRegion: "NSW",
          postalCode: "2000",
          addressCountry: "AU",
        },
        openingHoursSpecification: [
          { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "09:00", closes: "17:00" },
        ],
        areaServed: ["Sydney", "Greater Sydney"],
        sameAs: ["https://facebook.com/acmebookkeeping"],
      },
    ],
    schema_types: ["LocalBusiness"],
    main_text: "Acme Bookkeeping helps small businesses in Sydney keep their accounts accurate and file on time. Call us or drop into our office on Main St.",
  });
  const contactRow: JobPageRow = {
    id: "9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c",
    url: contactPage.url,
    http_status: contactPage.status,
    data: serializePageData(contactPage),
    content: contactPage.main_text ?? null,
    modules: {
      tech_fingerprint: fingerprintTech(contactPage),
      business_info: extractBusinessInfo(contactPage),
    },
  };

  bodies["pages.json"] = envelope({
    object: "list",
    job_id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
    items: [serializePageListItem(contactRow)],
    page: { limit: 50, offset: 0, total: 1, has_more: false },
  });
  bodies["page.json"] = envelope(serializePageDetail(contactRow, true));

  const files: Record<string, string> = {};
  for (const [name, body] of Object.entries(bodies)) {
    files[name] = JSON.stringify(body, null, 2) + "\n";
  }
  return files;
}

/** Write the samples to disk. Only invoked when this file is run directly. */
export function writeSamples(dir: string = SAMPLES_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(buildSamples())) {
    fs.writeFileSync(path.join(dir, name), contents);
    // eslint-disable-next-line no-console
    console.log(`wrote ${path.join(dir, name)}`);
  }
}

if (require.main === module) {
  writeSamples();
}
