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
} from "./modules";

/** The ordered, mode-independent post-crawl stages. */
export const SHARED_POST_CRAWL_MODULES: ScanModule[] = [
  storePagesModule,
  botBlockModule,
  siteAnalysisModule,
  issueDetectionModule,
  backlinkModule,
];

/**
 * The modules to run (in order) for a given scan mode, after the crawl + guards
 * and before the mode strategy. Both modes share the same post-crawl modules
 * today; this is the seam where a future mode could add or drop stages.
 */
export function composePipeline(_mode: ScanMode): ScanModule[] {
  return SHARED_POST_CRAWL_MODULES;
}
