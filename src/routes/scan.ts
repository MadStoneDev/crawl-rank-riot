import { AppError } from "../utils/error";
import { WebCrawler } from "../services/crawler";
import { getSupabaseServiceClient } from "../services/database/client";
import { Router, Request, Response, NextFunction } from "express";
import {
  createSuccessResponse,
  errorHandlerMiddleware,
} from "../services/api/responses";
import { AuthenticatedRequest } from "../middleware/auth";
import { storeScanResults } from "../services/database";
import { detectAndStoreIssues } from "../services/issue-detector";
import { checkAndStoreBacklinks } from "../services/backlink-checker";
import { AuditAnalyzer } from "../services/audit-analyzer";
import { storeAuditResults } from "../services/audit-database";
import { analyzeSiteLevelData } from "../services/site-analyzer";
import { detectSiteLevelIssues } from "../services/site-issue-detector";

const router = Router();

/**
 * POST /api/scan - Start a new SEO scan (full crawl)
 */
router.post(
  "/scan",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { project_id, options = {} } = req.body;

      // Validate inputs
      if (!project_id) {
        return next(
          new AppError(
            "Project ID is required",
            "VALIDATION_ERROR",
            undefined,
            400,
          ),
        );
      }

      const supabase = getSupabaseServiceClient();

      // Authorization: verify the authenticated user owns the project
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.id;

      const { data: ownedProject, error: ownerError } = await supabase
        .from("projects")
        .select("id, url, user_id")
        .eq("id", project_id)
        .single();

      if (ownerError || !ownedProject) {
        return next(
          new AppError(
            "Project not found",
            "PROJECT_NOT_FOUND",
            ownerError,
            404,
          ),
        );
      }

      if (ownedProject.user_id !== userId) {
        return next(
          new AppError(
            "You do not have permission to scan this project",
            "FORBIDDEN",
            undefined,
            403,
          ),
        );
      }

      const project = ownedProject;

      console.log(
        `SEO scan request received for Project ID: ${project_id}, URL: ${project.url}`,
      );

      // Create a new scan record with SEO type
      const { data: scanData, error: scanError } = await supabase
        .from("scans")
        .insert({
          project_id: project_id,
          scan_type: "seo",
          status: "in_progress",
          started_at: new Date().toISOString(),
          pages_scanned: 0,
          links_scanned: 0,
          issues_found: 0,
          last_progress_update: new Date().toISOString(),
        })
        .select()
        .single();

      if (scanError) {
        return next(
          new AppError(
            "Failed to create scan record",
            "DATABASE_ERROR",
            scanError,
            500,
          ),
        );
      }

      const scanId = scanData.id;

      // Update project's last_scan_at timestamp
      await supabase
        .from("projects")
        .update({ last_scan_at: new Date().toISOString() })
        .eq("id", project_id);

      // SEO scans are more comprehensive — clamp values to safe ranges
      const maxPages = Math.max(1, Math.min(Number(options?.maxPages) || 500, 100000));
      // Timeout scales with maxPages: ~2s per page, min 5 minutes, max 6 hours
      const defaultTimeout = Math.max(300_000, maxPages * 2_000);
      const crawlerOptions = {
        maxDepth: Math.max(1, Math.min(Number(options?.maxDepth) || 5, 10)),
        maxPages,
        concurrentRequests: Math.max(1, Math.min(Number(options?.concurrentRequests) || 3, 10)),
        timeout: Math.max(300_000, Math.min(Number(options?.timeout) || defaultTimeout, 21_600_000)),
        checkSitemaps: options?.checkSitemaps !== false,
        crawlMode: "seo" as const,
      };

      // Return early response to client
      res.json(
        createSuccessResponse(
          {
            project_id,
            scan_id: scanId,
            url: project.url,
            scan_type: "seo",
          },
          "SEO scan started successfully",
        ),
      );

      // Run the SEO scan in the background
      processSEOScanInBackground(
        project.url,
        crawlerOptions,
        scanId,
        project_id,
      );
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/scan/audit - Start a new audit scan
 */
router.post(
  "/scan/audit",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { project_id, options = {} } = req.body;

      // Validate inputs
      if (!project_id) {
        return next(
          new AppError(
            "Project ID is required",
            "VALIDATION_ERROR",
            undefined,
            400,
          ),
        );
      }

      const supabase = getSupabaseServiceClient();

      // Authorization: verify the authenticated user owns the project
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.id;

      const { data: ownedProject, error: ownerError } = await supabase
        .from("projects")
        .select("id, url, user_id")
        .eq("id", project_id)
        .single();

      if (ownerError || !ownedProject) {
        return next(
          new AppError(
            "Project not found",
            "PROJECT_NOT_FOUND",
            ownerError,
            404,
          ),
        );
      }

      if (ownedProject.user_id !== userId) {
        return next(
          new AppError(
            "You do not have permission to scan this project",
            "FORBIDDEN",
            undefined,
            403,
          ),
        );
      }

      const project = ownedProject;

      console.log(
        `Audit scan request received for Project ID: ${project_id}, URL: ${project.url}`,
      );

      // Create a new scan record with audit type
      const { data: scanData, error: scanError } = await supabase
        .from("scans")
        .insert({
          project_id: project_id,
          scan_type: "audit",
          status: "in_progress",
          started_at: new Date().toISOString(),
          pages_scanned: 0,
          links_scanned: 0,
          issues_found: 0,
          last_progress_update: new Date().toISOString(),
        })
        .select()
        .single();

      if (scanError) {
        return next(
          new AppError(
            "Failed to create scan record",
            "DATABASE_ERROR",
            scanError,
            500,
          ),
        );
      }

      const scanId = scanData.id;

      // Update project's last_scan_at timestamp
      await supabase
        .from("projects")
        .update({ last_scan_at: new Date().toISOString() })
        .eq("id", project_id);

      // Audit scans can be shallower — clamp values to safe ranges
      const auditMaxPages = Math.max(1, Math.min(Number(options?.maxPages) || 50, 100000));
      const auditDefaultTimeout = Math.max(300_000, auditMaxPages * 2_000);
      const crawlerOptions = {
        maxDepth: Math.max(1, Math.min(Number(options?.maxDepth) || 2, 10)),
        maxPages: auditMaxPages,
        concurrentRequests: Math.max(1, Math.min(Number(options?.concurrentRequests) || 3, 10)),
        timeout: Math.max(300_000, Math.min(Number(options?.timeout) || auditDefaultTimeout, 21_600_000)),
        checkSitemaps: options?.checkSitemaps !== false,
        crawlMode: "audit" as const,
      };

      // Return early response to client
      res.json(
        createSuccessResponse(
          {
            project_id,
            scan_id: scanId,
            url: project.url,
            scan_type: "audit",
          },
          "Audit scan started successfully",
        ),
      );

      // Run the audit scan in the background
      processAuditScanInBackground(
        project.url,
        crawlerOptions,
        scanId,
        project_id,
      );
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/scan/audit/:scanId - Get audit scan results
 */
router.get(
  "/scan/audit/:scanId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scanId } = req.params;
      const supabase = getSupabaseServiceClient();

      // Get scan info
      const { data: scan, error: scanError } = await supabase
        .from("scans")
        .select("*")
        .eq("id", scanId)
        .eq("scan_type", "audit")
        .single();

      if (scanError || !scan) {
        return next(
          new AppError(
            "Audit scan not found",
            "SCAN_NOT_FOUND",
            scanError,
            404,
          ),
        );
      }

      // Authorization: verify the scan belongs to a project owned by the user
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.id;

      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, user_id")
        .eq("id", scan.project_id)
        .single();

      if (projectError || !project || project.user_id !== userId) {
        return next(
          new AppError(
            "You do not have permission to view this scan",
            "FORBIDDEN",
            undefined,
            403,
          ),
        );
      }

      // Get audit results if completed
      let auditResults = null;
      if (scan.status === "completed") {
        const { data: auditData } = await supabase
          .from("audit_results")
          .select("*")
          .eq("scan_id", scanId)
          .single();

        auditResults = auditData;
      }

      res.json(
        createSuccessResponse({
          scan,
          audit_results: auditResults,
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Create a snapshot of the current project state after a scan completes.
 */
async function createScanSnapshot(
  projectId: string,
  scanId: string,
  pagesScanned: number,
  issuesFound: number,
  startedAt: string,
  completedAt: string,
): Promise<void> {
  try {
    const supabase = getSupabaseServiceClient();

    // Get issue counts by severity for this scan
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

    // Get page statistics
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

    // Get broken links count
    const { count: brokenLinks } = await supabase
      .from("page_links")
      .select("*", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("is_broken", true);

    // Calculate average SEO score based on title, meta_description, h1s presence
    const { data: pagesWithData } = await supabase
      .from("pages")
      .select("title, meta_description, h1s")
      .eq("project_id", projectId)
      .like("url", "http%");

    let avgSeoScore = 0;
    if (pagesWithData && pagesWithData.length > 0) {
      const scores = pagesWithData.map((page) => {
        let score = 100;
        if (!page.title) score -= 20;
        if (!page.meta_description) score -= 15;
        const h1Count = Array.isArray(page.h1s) ? page.h1s.length : 0;
        if (h1Count === 0) score -= 15;
        else if (h1Count > 1) score -= 5;
        return Math.max(0, score);
      });
      avgSeoScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    }

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
      .insert({
        scan_id: scanId,
        snapshot_data: snapshotData,
      });

    if (snapshotError) {
      console.error(`Error creating snapshot for scan ${scanId}:`, snapshotError);
    } else {
      console.log(`Snapshot created for scan ${scanId}`);
    }
  } catch (error) {
    // Snapshot creation is non-critical — log but don't throw
    console.error(`Failed to create snapshot for scan ${scanId}:`, error);
  }
}

/**
 * Process SEO scan in the background
 */
async function processSEOScanInBackground(
  url: string,
  options: any,
  scanId: string,
  projectId: string,
): Promise<void> {
  try {
    console.log(`Starting background SEO crawl for ${url}`);

    const crawler = new WebCrawler(url, scanId, projectId);
    const scanResults = await crawler.crawl(url, options);

    console.log(
      `SEO crawl completed for ${url}, found ${scanResults.length} pages`,
    );

    // Store SEO scan results
    await storeScanResults(projectId, scanId, scanResults);

    // Run site-level analysis (llms.txt, robots.txt AI bots, sitemap validation)
    let siteLevelData;
    try {
      console.log(`Running site-level analysis for ${url}...`);
      siteLevelData = await analyzeSiteLevelData(url, scanResults);
      console.log(
        `Site-level analysis complete: llms.txt=${siteLevelData.llms_txt?.exists}, robots.txt=${siteLevelData.robots_txt?.exists}, sitemap=${siteLevelData.sitemap_validation?.found}`,
      );
    } catch (error) {
      console.error("Site-level analysis failed (non-critical):", error);
    }

    // Detect and store issues
    const issuesFound = await detectAndStoreIssues(
      scanResults,
      projectId,
      scanId,
    );

    // Detect site-level issues (llms.txt, robots.txt, sitemap)
    let siteIssuesFound = 0;
    if (siteLevelData) {
      try {
        const supabaseForLookup = getSupabaseServiceClient();
        const { data: homepagePage } = await supabaseForLookup
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
      } catch (error) {
        console.error("Site-level issue detection failed (non-critical):", error);
      }
    }

    // Check for backlinks from external pages
    const backlinksFound = await checkAndStoreBacklinks(projectId, url);

    // Update scan as completed
    const supabase = getSupabaseServiceClient();
    const completedAt = new Date().toISOString();
    const totalIssues = issuesFound + siteIssuesFound;
    await supabase
      .from("scans")
      .update({
        status: "completed",
        completed_at: completedAt,
        pages_scanned: scanResults.length,
        issues_found: totalIssues,
        ...(siteLevelData && {
          summary_stats: JSON.parse(JSON.stringify({
            site_level_data: siteLevelData,
          })),
        }),
      })
      .eq("id", scanId);

    // Create a snapshot for historical trends
    // Fetch the scan to get started_at
    const { data: scanRecord } = await supabase
      .from("scans")
      .select("started_at")
      .eq("id", scanId)
      .single();

    await createScanSnapshot(
      projectId,
      scanId,
      scanResults.length,
      totalIssues,
      scanRecord?.started_at || completedAt,
      completedAt,
    );

    console.log(
      `SEO scan completed for project ${projectId}, scan ${scanId}, ${totalIssues} issues found (${siteIssuesFound} site-level), ${backlinksFound} backlinks discovered`,
    );
  } catch (error) {
    console.error(`Error in SEO scan process for scan ${scanId}:`, error);

    try {
      const supabase = getSupabaseServiceClient();
      await supabase
        .from("scans")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          summary_stats: {
            error_message:
              error instanceof Error ? error.message : "Unknown error",
            failed_at: new Date().toISOString(),
          },
        })
        .eq("id", scanId);
    } catch (dbError) {
      console.error(
        `Failed to update scan ${scanId} status to failed:`,
        dbError,
      );
    }
  }
}

/**
 * Process audit scan in the background
 */
async function processAuditScanInBackground(
  url: string,
  options: any,
  scanId: string,
  projectId: string,
): Promise<void> {
  try {
    console.log(`Starting background audit crawl for ${url}`);

    const crawler = new WebCrawler(url, scanId, projectId);
    const scanResults = await crawler.crawl(url, options);

    console.log(
      `Audit crawl completed for ${url}, found ${scanResults.length} pages`,
    );

    // Run audit analysis
    const analyzer = new AuditAnalyzer(scanResults, url);
    const { analysis, recommendations, overallScore } =
      await analyzer.analyze();

    // Prepare audit result data
    const auditData = {
      scan_id: scanId,
      project_id: projectId,
      modernization_score: analysis.modernization.score,
      performance_score: analysis.performance.score,
      completeness_score: analysis.completeness.score,
      conversion_score: 0, // Placeholder for now
      overall_score: overallScore,
      tech_stack: analysis.techStack,
      design_analysis: analysis.design,
      missing_pages: analysis.completeness.missingPages,
      found_pages: analysis.completeness.foundPages,
      performance_metrics: analysis.performance,
      modern_standards: analysis.modernStandards,
      recommendations: recommendations,
    };

    // Store audit results
    await storeAuditResults(projectId, scanId, auditData);

    // Run site-level analysis (llms.txt, robots.txt AI bots, sitemap validation)
    let siteLevelData;
    try {
      siteLevelData = await analyzeSiteLevelData(url, scanResults);
      console.log(
        `Audit site-level analysis complete: robots.txt=${siteLevelData.robots_txt?.exists}, sitemap=${siteLevelData.sitemap_validation?.found}`,
      );
    } catch (error) {
      console.error("Site-level analysis failed (non-critical):", error);
    }

    // Detect and store issues (audit scans also benefit from issue detection)
    const issuesFound = await detectAndStoreIssues(
      scanResults,
      projectId,
      scanId,
    );

    // Detect site-level issues
    let siteIssuesFound = 0;
    if (siteLevelData) {
      try {
        const supabaseForLookup = getSupabaseServiceClient();
        const { data: homepagePage } = await supabaseForLookup
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
      } catch (error) {
        console.error("Site-level issue detection failed:", error);
      }
    }

    // Check for backlinks from external pages
    const backlinksFound = await checkAndStoreBacklinks(projectId, url);

    // Update scan as completed
    const supabase = getSupabaseServiceClient();
    const completedAt = new Date().toISOString();
    const totalIssues = issuesFound + siteIssuesFound;
    await supabase
      .from("scans")
      .update({
        status: "completed",
        completed_at: completedAt,
        pages_scanned: scanResults.length,
        issues_found: totalIssues,
        summary_stats: JSON.parse(JSON.stringify({
          overall_score: overallScore,
          recommendations_count: recommendations.length,
          issues_found: totalIssues,
          backlinks_found: backlinksFound,
          ...(siteLevelData && { site_level_data: siteLevelData }),
        })),
      })
      .eq("id", scanId);

    // Create a snapshot for historical trends
    // Fetch the scan to get started_at
    const { data: scanRecord } = await supabase
      .from("scans")
      .select("started_at")
      .eq("id", scanId)
      .single();

    await createScanSnapshot(
      projectId,
      scanId,
      scanResults.length,
      issuesFound,
      scanRecord?.started_at || completedAt,
      completedAt,
    );

    console.log(
      `Audit scan completed for project ${projectId}, scan ${scanId}, score: ${overallScore}/100, ${issuesFound} issues found, ${backlinksFound} backlinks discovered`,
    );
  } catch (error) {
    console.error(`Error in audit scan process for scan ${scanId}:`, error);

    try {
      const supabase = getSupabaseServiceClient();
      await supabase
        .from("scans")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          summary_stats: {
            error_message:
              error instanceof Error ? error.message : "Unknown error",
            failed_at: new Date().toISOString(),
          },
        })
        .eq("id", scanId);
    } catch (dbError) {
      console.error(
        `Failed to update scan ${scanId} status to failed:`,
        dbError,
      );
    }
  }
}

export default router;
