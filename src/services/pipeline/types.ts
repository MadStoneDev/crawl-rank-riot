// Composable scan modules (Stage 3).
//
// The mode-independent stages that run after the crawl (store pages, detect bot
// protection, site-level analysis, issue detection, backlinks) are expressed as
// an ordered list of ScanModules over a shared, mutable PipelineContext. The
// orchestrator (scan-pipeline.ts) still owns crawl, the cancel/zero-page guards
// and finalize (control flow); modes still diverge only in the scoring/audit
// strategy. Each module delegates to its existing stage function — this is the
// composition seam, not a behaviour change.

import type { WebCrawler } from "../crawler";
import type { ScanLogger } from "../scan-logger";
import type { BotProtectionInfo } from "../../utils/bot-block";
import type { ScanResult, SiteLevelData } from "../../types";

export type ScanMode = "seo" | "audit";

/** Shared state threaded through the post-crawl modules. */
export interface PipelineContext {
  mode: ScanMode;
  url: string;
  // Clamped crawl options, as passed to the pipeline (shape owned by callers).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;
  scanId: string;
  projectId: string;
  crawler: WebCrawler;
  logger: ScanLogger;
  scanResults: ScanResult[];
  // Filled by modules as they run:
  botProtection: BotProtectionInfo | null;
  siteLevelData: SiteLevelData | undefined;
  issuesFound: number;
  siteIssuesFound: number;
  backlinksFound: number;
}

/** A single composable stage of the scan pipeline. */
export interface ScanModule {
  /** Stable identifier, used by composePipeline and the /v1 contract docs. */
  name: string;
  run(ctx: PipelineContext): Promise<void>;
}
