import { WebCrawler } from "./crawler";
import { storeScanResults } from "./database";
import { getSupabaseServiceClient } from "./database/client";
import { detectAndStoreIssues } from "./issue-detector";
import { checkAndStoreBacklinks } from "./backlink-checker";
import { AuditAnalyzer } from "./audit-analyzer";
import { storeAuditResults } from "./audit-database";
import { analyzeSiteLevelData } from "./site-analyzer";
import { detectSiteLevelIssues } from "./site-issue-detector";
import { ScanLogger } from "./scan-logger";
import { computeNextScanAt } from "../utils/scheduler";
import { detectBotBlock, BotProtectionInfo } from "../utils/bot-block";
import { computeScoreReport } from "../scoring/score-report";
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
const seoStrategy: ScanStrategy = async (ctx): Promise<ModeResult> => {
  const { scanResults, botProtection, scanId, projectId, logger } = ctx;

  const scoreReport = computeScoreReport(scanResults, { blocked: !!botProtection });
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
    conversion_score: 0,
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
      .select("severity")
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
async function markScanFailed(scanId: string, errorMessage: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const supabase = getSupabaseServiceClient();
      await supabase
        .from("scans")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          summary_stats: {
            error_message: errorMessage,
            failed_at: new Date().toISOString(),
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
): Promise<void> {
  const crawler = new WebCrawler(url, scanId, projectId);
  const logger = crawler.logger!;

  try {
    // 1. Crawl.
    const scanResults = await crawler.crawl(url, options);

    // 2. Store pages/links (guarded against wiping data on a partial crawl).
    logger.info("store", `Storing ${scanResults.length} pages in database...`);
    await storeScanResults(projectId, scanId, scanResults, {
      crawlCompleted: crawler.crawlCompleted,
    });
    logger.info("store", `Pages stored (crawlCompleted=${crawler.crawlCompleted})`);

    // 3. Bot-block detection (once, from crawler state).
    const botProtection = detectBotBlock({
      pagesScanned: scanResults.length,
      blockedCount: crawler.botBlockedCount,
      homepageBlocked: crawler.botBlockedHomepage,
      sampleError: crawler.botBlockSampleError,
    });
    if (botProtection) {
      logger.warn(
        "complete",
        `Scan blocked by bot protection — ${botProtection.blocked_pages}/${botProtection.total_pages} pages challenged. Customer should allowlist ${botProtection.egress_ip || "our crawler"}.`,
      );
    }

    // 4. Site-level analysis (robots.txt, sitemap, llms.txt). Non-critical.
    let siteLevelData: SiteLevelData | undefined;
    try {
      logger.info("analysis", "Running site-level analysis (robots.txt, sitemap, llms.txt)...");
      siteLevelData = await analyzeSiteLevelData(url, scanResults, {
        sitemapPath: options?.customSitemapPaths?.[0],
      });
      logger.info(
        "analysis",
        `Site-level analysis complete: llms.txt=${siteLevelData.llms_txt?.exists}, robots.txt=${siteLevelData.robots_txt?.exists}, sitemap=${siteLevelData.sitemap_validation?.found}`,
      );
    } catch (error) {
      logger.error("analysis", `Site-level analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 5. Page-level issues.
    logger.info("analysis", "Detecting issues...");
    const issuesFound = await detectAndStoreIssues(scanResults, projectId, scanId);
    logger.info("analysis", `Found ${issuesFound} page-level issues`);

    // 6. Site-level issues (needs the homepage page id).
    let siteIssuesFound = 0;
    if (siteLevelData) {
      try {
        const supabase = getSupabaseServiceClient();
        const { data: homepagePage } = await supabase
          .from("pages")
          .select("id")
          .eq("project_id", projectId)
          .eq("depth", 0)
          .limit(1)
          .single();

        siteIssuesFound = await detectSiteLevelIssues(
          siteLevelData,
          projectId,
          scanId,
          homepagePage?.id || null,
        );
        logger.info("analysis", `Found ${siteIssuesFound} site-level issues`);
      } catch (error) {
        logger.error("analysis", `Site-level issue detection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 7. Backlinks.
    logger.info("analysis", "Checking for backlinks...");
    const backlinksFound = await checkAndStoreBacklinks(projectId, url);
    logger.info("analysis", `Discovered ${backlinksFound} backlinks`);

    // 8. Mode-specific scoring / analysis.
    const totalIssues = issuesFound + siteIssuesFound;
    const totalLinksScanned = scanResults.reduce(
      (sum, page) => sum + page.internal_links.length + page.external_links.length,
      0,
    );
    const { snapshotOverall, summaryStatsPatch } = await STRATEGIES[mode]({
      mode,
      url,
      options,
      scanId,
      projectId,
      scanResults,
      botProtection,
      siteLevelData,
      issuesFound,
      siteIssuesFound,
      backlinksFound,
      totalIssues,
      totalLinksScanned,
      logger,
    });

    // 9. Finalize: mark completed (merging summary_stats), snapshot, project.
    const supabase = getSupabaseServiceClient();
    const completedAt = new Date().toISOString();

    const { data: existingScan } = await supabase
      .from("scans")
      .select("started_at, summary_stats")
      .eq("id", scanId)
      .single();

    const mergedStats = {
      ...(typeof existingScan?.summary_stats === "object" && existingScan.summary_stats !== null
        ? (existingScan.summary_stats as Record<string, unknown>)
        : {}),
      ...(siteLevelData && { site_level_data: siteLevelData }),
      ...(botProtection && { bot_protection: botProtection }),
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
        summary_stats: JSON.parse(JSON.stringify(mergedStats)),
      })
      .eq("id", scanId);

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

    logger.info(
      "complete",
      `Scan finished: ${scanResults.length} pages, ${totalLinksScanned} links, ${totalIssues} issues, ${backlinksFound} backlinks, overall ${snapshotOverall}${botProtection ? " (blocked)" : ""}`,
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
