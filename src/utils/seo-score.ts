import { ScanResult } from "../types";
import { computeScoreReport } from "../scoring/score-report";

/**
 * Backwards-compatible flat SEO score. This is now a thin adapter over the
 * canonical scorer (src/scoring/score-report.ts) so there is a single
 * implementation of the scoring math. Existing callers that only need the four
 * category numbers keep working; the richer ScoreReport (per-check + per-page)
 * is what gets persisted going forward.
 */

export interface SeoScore {
  technical: number;
  content: number;
  media: number;
  aeo: number;
  overall: number;
}

export function computeSeoScore(results: ScanResult[]): SeoScore {
  const report = computeScoreReport(results);
  return {
    technical: report.categories.technical.score,
    content: report.categories.content.score,
    media: report.categories.media.score,
    aeo: report.categories.aeo.score,
    overall: report.overall,
  };
}
