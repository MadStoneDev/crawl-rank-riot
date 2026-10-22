// Pipeline composition. The post-crawl modules run in this order for every
// scan; modes diverge only in the scoring/audit strategy that runs afterwards
// (see scan-pipeline.ts STRATEGIES). Exposing the composition as data makes new
// scan modes / job types a matter of selecting modules rather than editing one
// long function.

import type { ScanMode, ScanModule } from "./types";
import {
  storePagesModule,
  botBlockModule,
  siteAnalysisModule,
  issueDetectionModule,
  backlinkModule,
  techFingerprintModule,
  businessInfoModule,
  apiJobPagesModule,
} from "./modules";

/** The ordered, mode-independent post-crawl stages. */
export const SHARED_POST_CRAWL_MODULES: ScanModule[] = [
  storePagesModule,
  botBlockModule,
  siteAnalysisModule,
  issueDetectionModule,
  backlinkModule,
];

/** Options controlling composition (Stage 4). */
export interface ComposeOptions {
  /**
   * Public module names the caller selected (Stage 4 /api/v1 "modules"), or
   * null/undefined for the default full pipeline. "scoring" is handled by the
   * mode strategy in scan-pipeline.ts, not here.
   */
  modules?: string[] | null;
  /** True for API jobs — appends the per-job page snapshot module. */
  apiJob?: boolean;
}

/**
 * The modules to run (in order) after the crawl + guards and before the mode
 * strategy.
 *
 * - No `modules` selection → today's full pipeline (unchanged), plus the API
 *   page snapshot when this is an API job.
 * - With a `modules` selection (API only) → just the requested stages over a
 *   mandatory store/bot-block base, plus the snapshot. "scoring" is gated in
 *   the orchestrator; backlinks only run in the default pipeline.
 */
export function composePipeline(_mode: ScanMode, opts: ComposeOptions = {}): ScanModule[] {
  const selected = opts.modules ?? null;

  if (!selected) {
    return opts.apiJob
      ? [...SHARED_POST_CRAWL_MODULES, apiJobPagesModule]
      : SHARED_POST_CRAWL_MODULES;
  }

  const set = new Set(selected);
  // Extraction base is mandatory — you can't run any module without crawled,
  // stored pages. bot_block is cheap and keeps the blocked flag correct.
  const list: ScanModule[] = [storePagesModule, botBlockModule];
  if (set.has("tech_fingerprint")) list.push(techFingerprintModule);
  if (set.has("business_info")) list.push(businessInfoModule);
  if (set.has("issue_detection")) list.push(siteAnalysisModule, issueDetectionModule);
  if (opts.apiJob) list.push(apiJobPagesModule);
  return list;
}

/** The public module names a job may request. "scoring" runs the mode strategy. */
export const SELECTABLE_MODULES = [
  "fetch_extract",
  "tech_fingerprint",
  "business_info",
  "issue_detection",
  "scoring",
] as const;
