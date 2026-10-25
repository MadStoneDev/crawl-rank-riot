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
import { fingerprintTech, rollupTech } from "../extract/tech-fingerprint";
import { extractBusinessInfo, hasBusinessFacts } from "../extract/business-info";
import { serializePageData } from "../api/v1/serializers";
import { stage4Db } from "../api/v1/stage4-db";
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
 * Stage 4: tech_fingerprint. Derive each page's technology (platform,
 * analytics, booking/CRM/payment/email tools, frameworks, libraries) from its
 * real loaded assets + external links, stash per-URL for the snapshot module,
 * and compute a site-level rollup for the job's `result`.
 */
export const techFingerprintModule: ScanModule = {
  name: "tech_fingerprint",
  async run(ctx) {
    const fps = ctx.scanResults.map((r) => {
      const fp = fingerprintTech(r);
      const entry = ctx.pageModules.get(r.url) ?? {};
      entry.tech_fingerprint = fp;
      ctx.pageModules.set(r.url, entry);
      return fp;
    });
    ctx.techRollup = rollupTech(fps);
    ctx.logger.info("analysis", `tech_fingerprint: ${ctx.scanResults.length} pages`);
  },
};

/**
 * Stage 4: business_info. Extract NAP, opening hours, service areas and social
 * profiles from each page (JSON-LD + contact links + social externals), stash
 * per-URL for the snapshot module. Facts are tied to the page's source_url.
 */
export const businessInfoModule: ScanModule = {
  name: "business_info",
  async run(ctx) {
    let found = 0;
    for (const r of ctx.scanResults) {
      const info = extractBusinessInfo(r);
      if (!hasBusinessFacts(info)) continue;
      const entry = ctx.pageModules.get(r.url) ?? {};
      entry.business_info = info;
      ctx.pageModules.set(r.url, entry);
      found++;
    }
    ctx.logger.info("analysis", `business_info: facts on ${found}/${ctx.scanResults.length} pages`);
  },
};

/**
 * Stage 4: per-job page snapshot. Writes one api_job_pages row per crawled page
 * (standard extracted fields in `data`, cleaned main text in `content`, and any
 * tech_fingerprint/business_info output in `modules`), plus the site-level tech
 * rollup onto the job's `result`. Runs only for API jobs (ctx.apiJobId set) and
 * always last, so it captures the other modules' output. Best-effort: a write
 * failure is logged, never fatal.
 */
const MAX_CONTENT_CHARS = 100_000;
export const apiJobPagesModule: ScanModule = {
  name: "api_job_pages",
  async run(ctx) {
    if (!ctx.apiJobId) return;
    const { scanResults, projectId, apiJobId, logger } = ctx;
    const db = stage4Db();

    // Best-effort pages.id cross-reference for smaller jobs.
    const pageIdByUrl = new Map<string, string>();
    if (scanResults.length <= 500) {
      const urls = scanResults.map((r) => r.url);
      for (let i = 0; i < urls.length; i += 100) {
        try {
          const { data } = await db
            .from("pages")
            .select("id, url")
            .eq("project_id", projectId)
            .in("url", urls.slice(i, i + 100));
          for (const p of (data ?? []) as Array<{ id: string; url: string }>) {
            pageIdByUrl.set(p.url, p.id);
          }
        } catch {
          /* non-fatal */
        }
      }
    }

    const rows = scanResults.map((r) => {
      const extras = ctx.pageModules.get(r.url) ?? {};
      const modules: Record<string, unknown> = {};
      if (extras.tech_fingerprint) modules.tech_fingerprint = extras.tech_fingerprint;
      if (extras.business_info) modules.business_info = extras.business_info;
      const content = (r.main_text ?? "").slice(0, MAX_CONTENT_CHARS);
      return {
        job_id: apiJobId,
        page_id: pageIdByUrl.get(r.url) ?? null,
        url: r.url,
        http_status: r.status ?? null,
        data: JSON.parse(JSON.stringify(serializePageData(r))),
        content: content || null,
        modules,
      };
    });

    for (let i = 0; i < rows.length; i += 200) {
      try {
        const { error } = await db
          .from("api_job_pages")
          .upsert(rows.slice(i, i + 200), { onConflict: "job_id,url" });
        if (error) logger.warn("store", `api_job_pages write failed: ${error.message}`);
      } catch (e) {
        logger.warn("store", `api_job_pages write threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (ctx.techRollup) {
      try {
        await db
          .from("api_jobs")
          .update({ result: { tech_fingerprint: ctx.techRollup } })
          .eq("id", apiJobId);
      } catch {
        /* non-fatal */
      }
    }
    logger.info("store", `api_job_pages: wrote ${rows.length} rows for job ${apiJobId}`);
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
