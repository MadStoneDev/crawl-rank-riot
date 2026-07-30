import { ScanResult } from "../types";

/**
 * The canonical scorer. This is the ONE place scores are computed in RankRiot.
 * It runs in the crawler at scan completion, and the full ScoreReport is
 * persisted (scan_scores table). Every surface — dashboard, project detail,
 * per-page, trend chart — reads the stored report and never recomputes.
 *
 * Design goals (RANKRIOT_MASTER_PLAN.md Phase 1):
 *   - Pure and deterministic, so it is fully unit-testable.
 *   - Every category exposes its individual checks with the ACTUAL offending
 *     URLs, so the UI can show "here is the exact problem" instead of a generic
 *     example, and every "X passed" count is real (no placeholders).
 *   - A bot-blocked crawl scores 0, never a flattering "100 minus penalties".
 */

/** Bump when the scoring math changes. Persisted so we know how a scan was scored. */
export const SCORE_VERSION = 1;

/** How many offending URLs to retain per failing check (keeps the JSON bounded). */
const MAX_AFFECTED_URLS = 50;

const ADEQUATE_WORDS = 300;
const SLOW_MS = 3000;

export type CheckStatus = "pass" | "fail" | "na";

export interface CheckResult {
  /** Stable identifier, e.g. "http_ok". */
  id: string;
  /** Human label, e.g. "Returns a 2xx status". */
  label: string;
  status: CheckStatus;
  /** Items (pages or images) that passed. */
  passed: number;
  /** Items evaluated. `na` when 0. */
  total: number;
  /** Up to MAX_AFFECTED_URLS URLs of the items that failed. */
  affectedUrls: string[];
}

export interface CategoryScore {
  score: number; // 0-100
  checks: CheckResult[];
}

export interface PageScore {
  score: number; // 0-100
  checks: CheckResult[];
}

export interface ScoreReport {
  version: number;
  overall: number;
  categories: {
    technical: CategoryScore;
    content: CategoryScore;
    media: CategoryScore;
    aeo: CategoryScore;
  };
  /** Per-page scores keyed by URL. */
  pages: Record<string, PageScore>;
  blocked: boolean;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const pct = (n: number, total: number) => (total === 0 ? 0 : (n / total) * 100);

function isOk(r: ScanResult): boolean {
  return r.status >= 200 && r.status < 300;
}
function hasTitle(r: ScanResult): boolean {
  return !!r.title && r.title.trim().length > 0;
}
function hasMeta(r: ScanResult): boolean {
  return !!r.meta_description && r.meta_description.trim().length > 0;
}
function hasWords(r: ScanResult): boolean {
  return (r.word_count || 0) >= ADEQUATE_WORDS;
}
function hasH1(r: ScanResult): boolean {
  return Array.isArray(r.h1s) && r.h1s.length > 0;
}
function isFast(r: ScanResult): boolean {
  return (r.load_time_ms || 0) <= SLOW_MS;
}

/** AEO machine-readability signals, evaluated per page. */
const AEO_SIGNALS: Array<{ id: string; label: string; test: (r: ScanResult) => boolean }> = [
  { id: "schema_types", label: "Declares schema.org types", test: (r) => Array.isArray(r.schema_types) && r.schema_types.length > 0 },
  { id: "structured_data", label: "Has structured data", test: (r) => Array.isArray(r.structured_data) && r.structured_data.length > 0 },
  { id: "open_graph", label: "Has Open Graph tags", test: (r) => !!r.open_graph && Object.keys(r.open_graph).length > 0 },
  { id: "meta_description", label: "Has a meta description", test: hasMeta },
  { id: "title", label: "Has a title", test: hasTitle },
  { id: "h1", label: "Has an H1", test: hasH1 },
  { id: "word_count", label: "Has adequate body content", test: hasWords },
];

/**
 * Build a site-level CheckResult by evaluating `test` across every page.
 * status is `na` when there are no pages, `pass` when all pass, else `fail`.
 */
function pageCheck(
  results: ScanResult[],
  id: string,
  label: string,
  test: (r: ScanResult) => boolean,
): CheckResult {
  const failing = results.filter((r) => !test(r));
  const passed = results.length - failing.length;
  return {
    id,
    label,
    status: results.length === 0 ? "na" : failing.length === 0 ? "pass" : "fail",
    passed,
    total: results.length,
    affectedUrls: failing.slice(0, MAX_AFFECTED_URLS).map((r) => r.url),
  };
}

/** Per-page score = share of that page's own applicable checks that pass. */
function scorePage(r: ScanResult): PageScore {
  const checks: CheckResult[] = [];
  const single = (id: string, label: string, ok: boolean): void => {
    checks.push({ id, label, status: ok ? "pass" : "fail", passed: ok ? 1 : 0, total: 1, affectedUrls: ok ? [] : [r.url] });
  };

  single("http_ok", "Returns a 2xx status", isOk(r));
  single("indexable", "Is indexable", !!r.is_indexable);
  single("fast", "Loads quickly", isFast(r));
  single("title", "Has a title", hasTitle(r));
  single("meta_description", "Has a meta description", hasMeta(r));
  single("h1", "Has an H1", hasH1(r));
  single("word_count", "Has adequate body content", hasWords(r));
  for (const s of AEO_SIGNALS) {
    if (s.id === "title" || s.id === "meta_description" || s.id === "h1" || s.id === "word_count") continue; // avoid double-counting
    single(`aeo_${s.id}`, s.label, s.test(r));
  }

  // Image alt coverage as one check (na when the page has no images).
  const imgs = Array.isArray(r.images) ? r.images : [];
  const withAlt = imgs.filter((i) => i.alt && i.alt.trim().length > 0).length;
  if (imgs.length > 0) {
    checks.push({
      id: "img_alt",
      label: "Images have alt text",
      status: withAlt === imgs.length ? "pass" : "fail",
      passed: withAlt,
      total: imgs.length,
      affectedUrls: withAlt === imgs.length ? [] : [r.url],
    });
  }

  const scored = checks.filter((c) => c.status !== "na");
  const passedCount = scored.filter((c) => c.status === "pass").length;
  return { score: clamp(pct(passedCount, scored.length)), checks };
}

export function computeScoreReport(
  results: ScanResult[],
  opts: { blocked?: boolean } = {},
): ScoreReport {
  const blocked = !!opts.blocked;

  if (blocked || results.length === 0) {
    // A blocked crawl (or an empty one) never reached real content. Force 0 and
    // record empty checks rather than implying health.
    const empty = (): CategoryScore => ({ score: 0, checks: [] });
    return {
      version: SCORE_VERSION,
      overall: 0,
      categories: { technical: empty(), content: empty(), media: empty(), aeo: empty() },
      pages: {},
      blocked,
    };
  }

  const total = results.length;

  // --- Technical: mean of three site-wide pass rates ---
  const techChecks = [
    pageCheck(results, "http_ok", "Returns a 2xx status", isOk),
    pageCheck(results, "indexable", "Is indexable", (r) => !!r.is_indexable),
    pageCheck(results, "fast", "Loads quickly", isFast),
  ];
  const technicalRaw =
    (pct(techChecks[0].passed, total) + pct(techChecks[1].passed, total) + pct(techChecks[2].passed, total)) / 3;

  // --- Content: mean of four site-wide pass rates ---
  const contentChecks = [
    pageCheck(results, "title", "Has a title", hasTitle),
    pageCheck(results, "meta_description", "Has a meta description", hasMeta),
    pageCheck(results, "word_count", "Has adequate body content", hasWords),
    pageCheck(results, "h1", "Has an H1", hasH1),
  ];
  const contentRaw =
    contentChecks.reduce((sum, c) => sum + pct(c.passed, total), 0) / contentChecks.length;

  // --- Media: alt-text coverage across ALL images ---
  let totalImages = 0;
  let imagesWithAlt = 0;
  const pagesMissingAlt: string[] = [];
  for (const r of results) {
    const imgs = Array.isArray(r.images) ? r.images : [];
    let pageMissing = false;
    for (const img of imgs) {
      totalImages++;
      if (img.alt && img.alt.trim().length > 0) imagesWithAlt++;
      else pageMissing = true;
    }
    if (pageMissing) pagesMissingAlt.push(r.url);
  }
  const mediaRaw = totalImages === 0 ? 100 : pct(imagesWithAlt, totalImages);
  const mediaChecks: CheckResult[] = [
    {
      id: "img_alt",
      label: "Images have alt text",
      status: totalImages === 0 ? "na" : imagesWithAlt === totalImages ? "pass" : "fail",
      passed: imagesWithAlt,
      total: totalImages,
      affectedUrls: pagesMissingAlt.slice(0, MAX_AFFECTED_URLS),
    },
  ];

  // --- AEO: mean of per-page machine-readability, with per-signal breakdown ---
  const aeoChecks = AEO_SIGNALS.map((s) => pageCheck(results, `aeo_${s.id}`, s.label, s.test));
  const aeoRaw =
    results.reduce((sum, r) => {
      const passed = AEO_SIGNALS.filter((s) => s.test(r)).length;
      return sum + pct(passed, AEO_SIGNALS.length);
    }, 0) / total;

  const overall = clamp((technicalRaw + contentRaw + mediaRaw + aeoRaw) / 4);

  const pages: Record<string, PageScore> = {};
  for (const r of results) pages[r.url] = scorePage(r);

  return {
    version: SCORE_VERSION,
    overall,
    categories: {
      technical: { score: clamp(technicalRaw), checks: techChecks },
      content: { score: clamp(contentRaw), checks: contentChecks },
      media: { score: clamp(mediaRaw), checks: mediaChecks },
      aeo: { score: clamp(aeoRaw), checks: aeoChecks },
    },
    pages,
    blocked,
  };
}
