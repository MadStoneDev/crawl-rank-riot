// The post-crawl scan modules. Each body is the code that previously lived
// inline in runScanPipeline, moved verbatim behind a named module so the
// pipeline is a composition of stages. No behaviour change.

import { storeScanResults } from "../database";
import { getSupabaseServiceClient } from "../database/client";
import { detectAndStoreIssues, DetectedIssue } from "../issue-detector";
import { checkAndStoreBacklinks } from "../backlink-checker";
import { analyzeSiteLevelData } from "../site-analyzer";
import { detectSiteLevelIssues } from "../site-issue-detector";
import { detectBotBlock } from "../../utils/bot-block";
import type { ScanModule } from "./types";

/** 2. Store pages/links (guarded against wiping data on a partial crawl). */
export const storePagesModule: ScanModule = {
  name: "store_pages",
  async run(ctx) {
    const { scanResults, projectId, scanId, crawler, logger } = ctx;
    logger.info("store", `Storing ${scanResults.length} pages in database...`);
    await storeScanResults(projectId, scanId, scanResults, {
      crawlCompleted: crawler.crawlCompleted,
    });
    logger.info("store", `Pages stored (crawlCompleted=${crawler.crawlCompleted})`);
  },
};

/** 3. Bot-block detection (once, from crawler state). */
export const botBlockModule: ScanModule = {
  name: "bot_block_detection",
  async run(ctx) {
    const { scanResults, crawler, logger } = ctx;
    const botProtection = detectBotBlock({
      pagesScanned: scanResults.length,
      blockedCount: crawler.botBlockedCount,
      homepageBlocked: crawler.botBlockedHomepage,
      sampleError: crawler.botBlockSampleError,
    });
    ctx.botProtection = botProtection;
    if (botProtection) {
      logger.warn(
        "complete",
        `Scan blocked by bot protection — ${botProtection.blocked_pages}/${botProtection.total_pages} pages challenged. Customer should allowlist ${botProtection.egress_ip || "our crawler"}.`,
      );
    }
  },
};

/** 4. Site-level analysis (robots.txt, sitemap, llms.txt). Non-critical. */
export const siteAnalysisModule: ScanModule = {
  name: "site_analysis",
  async run(ctx) {
    const { url, scanResults, options, logger } = ctx;
    try {
      logger.info("analysis", "Running site-level analysis (robots.txt, sitemap, llms.txt)...");
      ctx.siteLevelData = await analyzeSiteLevelData(url, scanResults, {
        sitemapPath: options?.customSitemapPaths?.[0],
      });
      logger.info(
        "analysis",
        `Site-level analysis complete: llms.txt=${ctx.siteLevelData.llms_txt?.exists}, robots.txt=${ctx.siteLevelData.robots_txt?.exists}, sitemap=${ctx.siteLevelData.sitemap_validation?.found}`,
      );
    } catch (error) {
      logger.error("analysis", `Site-level analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

/**
 * 5. Build site-level issues first (needs the homepage page id), then detect
 * page issues and reconcile BOTH together so site issues get a fingerprint /
 * identity and are counted by Compare (P1.1).
 */
export const issueDetectionModule: ScanModule = {
  name: "issue_detection",
  async run(ctx) {
    const { scanResults, projectId, scanId, logger } = ctx;
    let siteIssues: DetectedIssue[] = [];
    if (ctx.siteLevelData) {
      try {
        const supabase = getSupabaseServiceClient();
        const { data: homepagePage } = await supabase
          .from("pages")
          .select("id")
          .eq("project_id", projectId)
          .eq("depth", 0)
          .limit(1)
          .single();

        siteIssues = detectSiteLevelIssues(
          ctx.siteLevelData,
          projectId,
          scanId,
          homepagePage?.id || null,
        );
      } catch (error) {
        logger.error("analysis", `Site-level issue detection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    ctx.siteIssuesFound = siteIssues.length;

    logger.info("analysis", "Detecting issues...");
    ctx.issuesFound = await detectAndStoreIssues(scanResults, projectId, scanId, siteIssues);
    logger.info("analysis", `Found ${ctx.issuesFound} issues (${ctx.siteIssuesFound} site-level)`);
  },
};

/**
 * 6. Backlinks (disabled by default). The current check only fetches the sites
 * we link OUT to and looks for a link back — i.e. reciprocal links, a tiny
 * biased slice of real backlinks — for ~40s of wall-clock per scan and
 * near-zero useful results. Real backlink data needs Google Search Console or a
 * third-party index, not a crawl of our own outbound links, so it's off until
 * then. Set ENABLE_BACKLINK_CHECK=true to re-enable the experimental checker.
 */
export const backlinkModule: ScanModule = {
  name: "backlinks",
  async run(ctx) {
    const { projectId, url, logger } = ctx;
    if (process.env.ENABLE_BACKLINK_CHECK === "true") {
      logger.info("analysis", "Checking for backlinks (experimental)...");
      ctx.backlinksFound = await checkAndStoreBacklinks(projectId, url);
      logger.info("analysis", `Discovered ${ctx.backlinksFound} backlinks`);
    } else {
      logger.info("analysis", "Backlink check skipped (work in progress)");
    }
  },
};
