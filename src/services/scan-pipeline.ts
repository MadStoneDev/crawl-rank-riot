import { WebCrawler, describePartialCrawl } from "./crawler";
import { ScannerDeps } from "./scanner";
import { getSupabaseServiceClient } from "./database/client";
import { computeCanonicalisedVariants } from "./issue-detector";
import { isCancelled, clearCancel } from "./scan-cancellation";
import { AuditAnalyzer } from "./audit-analyzer";
import { storeAuditResults } from "./audit-database";
import { ScanLogger } from "./scan-logger";
import { composePipeline } from "./pipeline/compose";
import { PipelineContext } from "./pipeline/types";
import { computeNextScanAt } from "../utils/scheduler";
import { BotProtectionInfo, detectBotBlock } from "../utils/bot-block";
import { computeScoreReport } from "../scoring/score-report";
import { computeWeightedScore, IssueAggregate } from "../scoring/weighted-score";
import { CRAWLER_VERSION, CHECK_VERSION } from "../config/versions";
import { ScanResult, SiteLevelData } from "../types";

/**
 * The ONE scan execution pipeline for RankRiot.
 *
 * Every scan — manual SEO, manual audit, and scheduled (both types) — runs
 * through runScanPipeline(). The steps that are identical for every scan (crawl,
 * store, bot-block detection, site-level analysis, issue detection, backlinks,
 * finalize, error handling) live here once. The steps that differ by mode
 * (scoring for SEO, the AuditAnalyzer for audit) live in a small strategy per
 * mode. This replaces three copy-pasted variants that had already drifted apart
 * (the scheduler's SEO path skipped scoring, issues, backlinks, and the trend
 * snapshot entirely).
 *
 * Contract: the caller creates the `scans` row (status in_progress) and clamps
 * crawl options — that is entry-point-specific (auth, plan limits, scheduling).
 * This function takes it from the crawl onward.
 */

export type ScanMode = "seo" | "audit";

/** Everything a mode strategy needs, computed by the shared pipeline. */
interface ScanContext {
  mode: ScanMode;
  url: string;
  options: any;
  scanId: string;
  projectId: string;
  scanResults: ScanResult[];
  botProtection: BotProtectionInfo | null;
  siteLevelData: SiteLevelData | undefined;
  issuesFound: number;
  siteIssuesFound: number;
  backlinksFound: number;
  totalIssues: number;
  totalLinksScanned: number;
  logger: ScanLogger;
}

/** What a mode strategy returns to the shared finalize step. */
interface ModeResult {
  /** Canonical overall score for the trend snapshot. */
  snapshotOverall: number;
  /** Fields merged into the scan's summary_stats (e.g. seo_score, overall_score). */
  summaryStatsPatch: Record<string, unknown>;
}

type ScanStrategy = (ctx: ScanContext) => Promise<ModeResult>;

/**
 * SEO strategy: compute the canonical ScoreReport once and persist it. A blocked
 * crawl is forced to 0 by the scorer. Writes the full report to scan_scores and
 * a flat copy to summary_stats.seo_score.
 */
type SeverityName = "critical" | "high" | "medium" | "low";
const SEVERITY_RANK: Record<SeverityName, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/**
 * Load open-issue data for scoring: per-page critical/high counts (for per-page
 * caps) and per-issue-type aggregates (for the severity × volume model, P1.2).
 * Issues are stored before the strategy runs, so this reflects this scan.
 */
async function loadIssueData(projectId: string): Promise<{
  site: { critical: number; high: number };
  perPage: Record<string, { critical: number; high: number }>;
  aggregates: IssueAggregate[];
}> {
  const site = { critical: 0, high: 0 };
  const perPage: Record<string, { critical: number; high: number }> = {};
  // Per issue type: worst severity + the set of distinct affected pages.
  const byType = new Map<string, { severity: SeverityName; pages: Set<string> }>();
  try {
    const supabase = getSupabaseServiceClient();
    const [{ data: issueRows }, { data: pageRows }] = await Promise.all([
      supabase
        .from("issues")
        .select("issue_type, severity, page_id")
        .eq("project_id", projectId)
        .eq("is_fixed", false)
        .eq("dismissed", false),
      supabase.from("pages").select("id, url").eq("project_id", projectId),
    ]);
    const idToUrl = new Map((pageRows ?? []).map((p) => [p.id as string, p.url as string]));
    for (const row of issueRows ?? []) {
      const sev = (row.severity || "low").toLowerCase() as SeverityName;
      if (sev === "critical" || sev === "high") {
        site[sev]++;
        const url = row.page_id ? idToUrl.get(row.page_id as string) : undefined;
        if (url) {
          const pp = (perPage[url] ??= { critical: 0, high: 0 });
          pp[sev]++;
        }
      }
      const type = row.issue_type as string;
      if (!type) continue;
      const entry = byType.get(type) ?? { severity: sev, pages: new Set<string>() };
      if ((SEVERITY_RANK[sev] ?? 0) > (SEVERITY_RANK[entry.severity] ?? 0)) entry.severity = sev;
      if (row.page_id) entry.pages.add(row.page_id as string);
      byType.set(type, entry);
    }
  } catch {
    // Non-fatal: fall back to an unpenalised/uncapped score.
  }
  const aggregates: IssueAggregate[] = Array.from(byType.entries()).map(
    ([issueType, v]) => ({ issueType, severity: v.severity, affectedPages: v.pages.size }),
  );
  return { site, perPage, aggregates };
}

const seoStrategy: ScanStrategy = async (ctx): Promise<ModeResult> => {
  const { scanResults, botProtection, scanId, projectId, logger } = ctx;

  // Canonicalised variants inherit their canonical's state and raise no findings
  // of their own — exclude them from the scored page set so they neither pad nor
  // dilute the score (P0 follow-up). Non-HTML resources (PDF, image, feed …)
  // aren't pages and raise no page findings, so they're excluded too (S-02):
  // leaving them in would pad the denominator and understate every issue share.
  const variants = computeCanonicalisedVariants(scanResults);
  const scoredResults = scanResults.filter(
    (r) => !variants.has(r.url) && !r.is_non_html,
  );

  // Open-issue data (already stored by this point): per-page caps + per-type
  // aggregates for the severity × volume model (P1.2).
  const { site, perPage, aggregates } = await loadIssueData(projectId);

  const scoreReport = computeScoreReport(scoredResults, {
    blocked: !!botProtection,
    severity: { site, perPage },
  });

  // Authoritative overall/category numbers come from the weighted model; the
  // pass-rate checks in scoreReport stay for the per-check display. A blocked /
  // empty crawl keeps the scorer's forced 0.
  const scoredPages = scoredResults.length;
  if (!botProtection && scoredPages > 0) {
    const weighted = computeWeightedScore(aggregates, scoredPages);
    scoreReport.overall = weighted.overall;
    scoreReport.categories.technical.score = weighted.categories.technical;
    scoreReport.categories.content.score = weighted.categories.content;
    scoreReport.categories.media.score = weighted.categories.media;
    scoreReport.categories.aeo.score = weighted.categories.aeo;
    scoreReport.capped = weighted.capped;
    // Attach the deduction breakdown + model marker for transparency (P1.2).
    scoreReport.deductions = weighted.deductions;
    scoreReport.scoreModel = "weighted-v1";
  }

  const seoScore = {
    technical: scoreReport.categories.technical.score,
    content: scoreReport.categories.content.score,
    media: scoreReport.categories.media.score,
    aeo: scoreReport.categories.aeo.score,
    overall: scoreReport.overall,
  };

  // Persist the full report (one row per scan). Non-fatal.
  try {
    const supabase = getSupabaseServiceClient();
    const { error: scoreError } = await supabase.from("scan_scores").upsert(
      {
        scan_id: scanId,
        project_id: projectId,
        version: scoreReport.version,
        overall: scoreReport.overall,
        technical: scoreReport.categories.technical.score,
        content: scoreReport.categories.content.score,
        media: scoreReport.categories.media.score,
        aeo: scoreReport.categories.aeo.score,
        geo: null,
        blocked: scoreReport.blocked,
        report: JSON.parse(JSON.stringify(scoreReport)),
      },
      { onConflict: "scan_id" },
    );
    if (scoreError) {
      logger.warn("complete", `Failed to persist scan_scores: ${scoreError.message}`);
    }
  } catch (err) {
    logger.warn(
      "complete",
      `Failed to persist scan_scores: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    snapshotOverall: seoScore.overall,
    summaryStatsPatch: { seo_score: seoScore },
  };
};

/**
 * Audit strategy: run the AuditAnalyzer and store its result. A blocked crawl
 * forces the overall + component scores to 0.
 */
const auditStrategy: ScanStrategy = async (ctx): Promise<ModeResult> => {
  const { scanResults, url, options, botProtection, scanId, projectId, totalIssues, backlinksFound } = ctx;

  const analyzer = new AuditAnalyzer(scanResults, url, options?.keyPages || {});
  const { analysis, recommendations, overallScore } = await analyzer.analyze();

  const effectiveOverallScore = botProtection ? 0 : overallScore;

  await storeAuditResults(projectId, scanId, {
    scan_id: scanId,
    project_id: projectId,
    modernization_score: botProtection ? 0 : analysis.modernization.score,
    performance_score: botProtection ? 0 : analysis.performance.score,
    completeness_score: botProtection ? 0 : analysis.completeness.score,
    // No conversion analysis exists — write null ("not measured"), never a
    // misleading 0 that reads as "worst possible" (§7.22).
    conversion_score: null,
    overall_score: effectiveOverallScore,
    tech_stack: analysis.techStack,
    design_analysis: analysis.design,
    missing_pages: analysis.completeness.missingPages,
    found_pages: analysis.completeness.foundPages,
    performance_metrics: analysis.performance,
    modern_standards: analysis.modernStandards,
    recommendations: recommendations,
  });

  return {
    snapshotOverall: effectiveOverallScore,
    summaryStatsPatch: {
      overall_score: effectiveOverallScore,
      recommendations_count: recommendations.length,
      issues_found: totalIssues,
      backlinks_found: backlinksFound,
    },
  };
};

const STRATEGIES: Record<ScanMode, ScanStrategy> = {
  seo: seoStrategy,
  audit: auditStrategy,
};

/**
 * Insert a trend snapshot for the scan. `overallScore` is the canonical overall
 * already computed by the mode strategy (0 on a bot-block), reused verbatim so
 * the history chart can never disagree with the headline number.
 */
export async function createScanSnapshot(
  projectId: string,
  scanId: string,
  pagesScanned: number,
  issuesFound: number,
  startedAt: string,
  completedAt: string,
  overallScore: number,
): Promise<void> {
  try {
    const supabase = getSupabaseServiceClient();

    const { data: issues } = await supabase
      .from("issues")
      .select("severity, fingerprint, issue_type, dismissed")
      .eq("project_id", projectId)
      .eq("scan_id", scanId);

    const issueCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    if (issues) {
      for (const issue of issues) {
        const severity = (issue.severity?.toLowerCase() || "low") as keyof typeof issueCounts;
        if (severity in issueCounts) {
          issueCounts[severity]++;
        }
      }
    }
    const totalIssues = issueCounts.critical + issueCounts.high + issueCounts.medium + issueCounts.low;

    // Per-scan identity data so Compare can diff two scans by fingerprint set
    // (fixed / new / unchanged), rather than subtracting totals (P1.1). Exclude
    // dismissed issues from the comparable set.
    const openRows = (issues ?? []).filter((r) => !r.dismissed);
    const issueFingerprints = Array.from(
      new Set(openRows.map((r) => r.fingerprint).filter((f): f is string => !!f)),
    );
    const issueTypesPresent = Array.from(
      new Set(openRows.map((r) => r.issue_type).filter((t): t is string => !!t)),
    );

    const { count: totalPages } = await supabase
      .from("pages")
      .select("*", { count: "exact", head: true })
      .eq("project_id", projectId)
      .like("url", "http%");

    const { count: indexablePages } = await supabase
      .from("pages")
      .select("*", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("is_indexable", true)
      .like("url", "http%");

    const { count: brokenLinks } = await supabase
      .from("page_links")
      .select("*", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("is_broken", true);

    // Crawled page ids let Compare classify a vanished issue as "page gone".
    // Capped so a very large crawl doesn't bloat the snapshot JSON.
    let crawledPageIds: string[] | undefined;
    if ((totalPages ?? 0) <= 5000) {
      const { data: pageRows } = await supabase
        .from("pages")
        .select("id")
        .eq("project_id", projectId)
        .like("url", "http%");
      crawledPageIds = (pageRows ?? []).map((p) => p.id as string);
    }

    // Reuse the canonical score passed in from the strategy. A bot-blocked crawl
    // arrives here already forced to 0, so there is no separate blocked branch.
    const avgSeoScore = Math.max(0, Math.min(100, Math.round(overallScore)));

    const snapshotData = {
      timestamp: new Date().toISOString(),
      metrics: {
        totalPages: totalPages || 0,
        indexablePages: indexablePages || 0,
        brokenLinks: brokenLinks || 0,
        avgSeoScore,
      },
      issues: {
        total: totalIssues,
        critical: issueCounts.critical,
        high: issueCounts.high,
        medium: issueCounts.medium,
        low: issueCounts.low,
      },
      // Identity data for Compare's fingerprint set-diff (P1.1).
      issueFingerprints,
      issueTypesPresent,
      ...(crawledPageIds ? { crawledPageIds } : {}),
      checkVersion: CHECK_VERSION,
      scan: {
        id: scanId,
        status: "completed",
        pagesScanned,
        issuesFound,
        startedAt,
        completedAt,
      },
    };

    const { error: snapshotError } = await supabase
      .from("scan_snapshots")
      .insert({ scan_id: scanId, snapshot_data: snapshotData });

    if (snapshotError) {
      console.error(`Error creating snapshot for scan ${scanId}:`, snapshotError);
    }
  } catch (error) {
    console.error(`Failed to create snapshot for scan ${scanId}:`, error);
  }
}

/** Mark a scan failed, retrying the status write a few times. */
async function markScanFailed(
  scanId: string,
  errorMessage: string,
  extraStats?: Record<string, unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const supabase = getSupabaseServiceClient();
      await supabase
        .from("scans")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          failure_reason: errorMessage,
          crawler_version: CRAWLER_VERSION,
          check_version: CHECK_VERSION,
          summary_stats: {
            error_message: errorMessage,
            failed_at: new Date().toISOString(),
            ...(extraStats ?? {}),
          },
        })
        .eq("id", scanId);
      return;
    } catch (dbError) {
      console.error(
        `Failed to update scan ${scanId} status to failed (attempt ${attempt + 1}/3):`,
        dbError,
      );
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

/**
 * Run a full scan end to end. The caller has already created the in_progress
 * `scans` row (scanId) and clamped `options`.
 */
export async function runScanPipeline(
  mode: ScanMode,
  url: string,
  options: any,
  scanId: string,
  projectId: string,
  scannerDeps?: ScannerDeps,
  apiJob?: { id: string; modules: string[] | null },
): Promise<void> {
  // Stage 4: an API job may select a subset of modules (modules !== null) and
  // gets a per-job page snapshot. modules === null ⇒ today's full pipeline.
  const selectedModules = apiJob?.modules ?? null;
  const runScoring = !selectedModules || selectedModules.includes("scoring");
  // `scannerDeps` forwards the Scanner's test-only DI seam (SSRF guard + fetch);
  // undefined in every production caller, so the strict guard is always used.
  const crawler = new WebCrawler(url, scanId, projectId, scannerDeps);
  const logger = crawler.logger!;

  try {
    // 1. Crawl.
    const scanResults = await crawler.crawl(url, options);

    // 1b. Cancelled? Stop here — mark the scan cancelled and leave the previous
    // scan's stored data untouched (don't store this partial crawl).
    if (isCancelled(scanId)) {
      clearCancel(scanId);
      const supabase = getSupabaseServiceClient();
      await supabase
        .from("scans")
        .update({ status: "cancelled", completed_at: new Date().toISOString() })
        .eq("id", scanId);
      logger.info("complete", "Scan cancelled by user");
      return;
    }

    // 1c. A crawl that produced zero usable pages is a FAILED scan, not a clean
    // site (P0.5). Marking it "completed" makes the UI show Health 0 / "no open
    // fixes — everything's clean" for a site that was never actually read. Fail
    // with a reason and leave any previous scan's data untouched.
    if (scanResults.length === 0) {
      const reason = crawler.robotsDisallowedSeed
        ? "robots.txt disallows RankRiotBot from the start URL, so no pages could be crawled. Allow RankRiotBot in robots.txt (or verify domain ownership to authorise a full crawl) and rescan."
        : crawler.botBlockedHomepage
        ? "The crawler was blocked by bot protection before it could read any pages. Allowlist RankRiotBot and rescan."
        : "No pages could be crawled. The start URL may be unreachable, redirect off-site, return a non-HTML response, or return an HTTP error. Check the URL and rescan.";
      // A fully-blocked crawl returns before the post-crawl bot-block module, so
      // compute and persist bot_protection here too — otherwise the frontend's
      // BotBlockedNotice (allowlist + Cloudflare steps, crawler UA/IP) has no
      // data to render for a site that blocked us outright (PC-09).
      const botProtection = crawler.botBlockedHomepage
        ? detectBotBlock({
            pagesScanned: 0,
            blockedCount: crawler.botBlockedCount,
            homepageBlocked: crawler.botBlockedHomepage,
            sampleError: crawler.botBlockSampleError,
          })
        : null;
      await markScanFailed(
        scanId,
        reason,
        botProtection ? { bot_protection: botProtection } : undefined,
      );
      logger.error("complete", `Scan failed (0 pages): ${reason}`);
      return;
    }

    // 2–6. Shared post-crawl stages, composed per mode (store pages, bot-block
    // detection, site-level analysis, issue detection, backlinks). Each module
    // reads/writes the shared PipelineContext; behaviour is unchanged from the
    // previously-inlined steps.
    const ctx: PipelineContext = {
      mode,
      url,
      options,
      scanId,
      projectId,
      crawler,
      logger,
      scanResults,
      botProtection: null,
      siteLevelData: undefined,
      issuesFound: 0,
      siteIssuesFound: 0,
      backlinksFound: 0,
      apiJobId: apiJob?.id,
      pageModules: new Map(),
    };
    for (const scanModule of composePipeline(mode, { modules: selectedModules, apiJob: !!apiJob })) {
      await scanModule.run(ctx);
    }

    // 7. Mode-specific scoring / analysis. issuesFound already includes the
    // site-level issues (reconciled together), so don't add them again. An API
    // job that did not select "scoring" skips the strategy entirely — it is a
    // pure extraction job, not a site-health scan (no score, no trend point).
    const totalIssues = ctx.issuesFound;
    const totalLinksScanned = scanResults.reduce(
      (sum, page) => sum + page.internal_links.length + page.external_links.length,
      0,
    );
    const { snapshotOverall, summaryStatsPatch } = runScoring
      ? await STRATEGIES[mode]({
          mode,
          url,
          options,
          scanId,
          projectId,
          scanResults,
          botProtection: ctx.botProtection,
          siteLevelData: ctx.siteLevelData,
          issuesFound: ctx.issuesFound,
          siteIssuesFound: ctx.siteIssuesFound,
          backlinksFound: ctx.backlinksFound,
          totalIssues,
          totalLinksScanned,
          logger,
        })
      : { snapshotOverall: 0, summaryStatsPatch: {} as Record<string, unknown> };

    // 9. Finalize: mark completed (merging summary_stats), snapshot, project.
    const supabase = getSupabaseServiceClient();
    const completedAt = new Date().toISOString();

    const { data: existingScan } = await supabase
      .from("scans")
      .select("started_at, summary_stats")
      .eq("id", scanId)
      .single();

    // Partial-crawl status (PL-03): a crawl that stopped on the page cap or a
    // timeout only sampled part of the site, so the headline score/trend point
    // must be caveated in the UI rather than read as the whole site's health.
    const partialCrawl = describePartialCrawl({
      crawlCompleted: crawler.crawlCompleted,
      crawlStopReason: crawler.crawlStopReason,
      queueRemainingAtStop: crawler.queueRemainingAtStop,
      pagesCrawled: scanResults.length,
    });

    const mergedStats = {
      ...(typeof existingScan?.summary_stats === "object" && existingScan.summary_stats !== null
        ? (existingScan.summary_stats as Record<string, unknown>)
        : {}),
      ...(ctx.siteLevelData && { site_level_data: ctx.siteLevelData }),
      ...(ctx.botProtection && { bot_protection: ctx.botProtection }),
      partial_crawl: partialCrawl,
      ...summaryStatsPatch,
    };

    await supabase
      .from("scans")
      .update({
        status: "completed",
        completed_at: completedAt,
        pages_scanned: scanResults.length,
        links_scanned: totalLinksScanned,
        issues_found: totalIssues,
        // Stamp the crawler/check version so the app can flag results produced
        // by a superseded version and offer a rescan (P0.6).
        crawler_version: CRAWLER_VERSION,
        check_version: CHECK_VERSION,
        summary_stats: JSON.parse(JSON.stringify(mergedStats)),
      })
      .eq("id", scanId);

    // Trend snapshot + project scheduling only for scored scans. A pure
    // extraction API job (modules without "scoring") must not write a history
    // point or reschedule the project as if a full health scan had run.
    if (runScoring) {
      await createScanSnapshot(
        projectId,
        scanId,
        scanResults.length,
        totalIssues,
        existingScan?.started_at || completedAt,
        completedAt,
        snapshotOverall,
      );

      const { data: projectData } = await supabase
        .from("projects")
        .select("scan_frequency")
        .eq("id", projectId)
        .single();

      const projectUpdate: any = { last_scan_at: completedAt };
      if (projectData?.scan_frequency) {
        const nextScanAt = computeNextScanAt(new Date(), projectData.scan_frequency);
        if (nextScanAt) {
          projectUpdate.next_scan_at = nextScanAt.toISOString();
        }
      }
      await supabase.from("projects").update(projectUpdate).eq("id", projectId);
    }

    logger.info(
      "complete",
      `Scan finished: ${scanResults.length} pages, ${totalLinksScanned} links, ${totalIssues} issues, ${ctx.backlinksFound} backlinks, overall ${snapshotOverall}${ctx.botProtection ? " (blocked)" : ""}`,
    );
    await logger.close();
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null
          ? JSON.stringify(error)
          : String(error);
    logger.error("complete", `Scan failed: ${errorMessage}`);
    await logger.close();
    await markScanFailed(scanId, errorMessage);
  }
}
