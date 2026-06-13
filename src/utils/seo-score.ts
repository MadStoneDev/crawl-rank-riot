import { ScanResult } from "../types";

/**
 * Canonical SEO score for a project, computed once at scan time and persisted
 * to scans.summary_stats.seo_score. Both the dashboard and the project detail
 * page read this single stored value so their numbers can never disagree
 * (previously each surface computed its own score with a different formula).
 *
 * Four equally-weighted categories, each 0-100, matching the project page's
 * Technical / Content / Media / AEO model:
 *   - Technical: share of pages that are reachable (2xx), indexable, and fast.
 *   - Content:   share of pages with a title, meta description, adequate body
 *                copy, and an H1.
 *   - Media:     alt-text coverage across all images (100 when there are none).
 *   - AEO:       average per-page machine-readability (schema, structured data,
 *                Open Graph, descriptive metadata) — how ready a page is to be
 *                cited by AI answer engines.
 *
 * A page that failed to load contributes 0 to the categories it touches rather
 * than being skipped, so a broken crawl cannot inflate the score.
 */

export interface SeoScore {
  technical: number;
  content: number;
  media: number;
  aeo: number;
  overall: number;
}

const ADEQUATE_WORDS = 300;
const SLOW_MS = 3000;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const pct = (n: number, total: number) => (total === 0 ? 0 : (n / total) * 100);

function isOk(r: ScanResult): boolean {
  return r.status >= 200 && r.status < 300;
}

/** Per-page AEO readiness (0-100) from machine-readability signals. */
function aeoPageScore(r: ScanResult): number {
  const signals = [
    Array.isArray(r.schema_types) && r.schema_types.length > 0,
    Array.isArray(r.structured_data) && r.structured_data.length > 0,
    !!r.open_graph && Object.keys(r.open_graph).length > 0,
    !!r.meta_description && r.meta_description.trim().length > 0,
    !!r.title && r.title.trim().length > 0,
    Array.isArray(r.h1s) && r.h1s.length > 0,
    (r.word_count || 0) >= ADEQUATE_WORDS,
  ];
  return pct(signals.filter(Boolean).length, signals.length);
}

export function computeSeoScore(results: ScanResult[]): SeoScore {
  const total = results.length;
  if (total === 0) {
    return { technical: 0, content: 0, media: 0, aeo: 0, overall: 0 };
  }

  // --- Technical ---
  const okPages = results.filter(isOk).length;
  const indexablePages = results.filter((r) => r.is_indexable).length;
  const fastPages = results.filter((r) => (r.load_time_ms || 0) <= SLOW_MS).length;
  const technical =
    (pct(okPages, total) + pct(indexablePages, total) + pct(fastPages, total)) / 3;

  // --- Content ---
  const withTitle = results.filter((r) => !!r.title && r.title.trim().length > 0).length;
  const withMeta = results.filter(
    (r) => !!r.meta_description && r.meta_description.trim().length > 0,
  ).length;
  const withWords = results.filter((r) => (r.word_count || 0) >= ADEQUATE_WORDS).length;
  const withH1 = results.filter((r) => Array.isArray(r.h1s) && r.h1s.length > 0).length;
  const content =
    (pct(withTitle, total) + pct(withMeta, total) + pct(withWords, total) + pct(withH1, total)) / 4;

  // --- Media (alt-text coverage) ---
  let totalImages = 0;
  let imagesWithAlt = 0;
  for (const r of results) {
    if (!Array.isArray(r.images)) continue;
    for (const img of r.images) {
      totalImages++;
      if (img.alt && img.alt.trim().length > 0) imagesWithAlt++;
    }
  }
  const media = totalImages === 0 ? 100 : pct(imagesWithAlt, totalImages);

  // --- AEO ---
  const aeo = results.reduce((sum, r) => sum + aeoPageScore(r), 0) / total;

  const overall = (technical + content + media + aeo) / 4;

  return {
    technical: clamp(technical),
    content: clamp(content),
    media: clamp(media),
    aeo: clamp(aeo),
    overall: clamp(overall),
  };
}
