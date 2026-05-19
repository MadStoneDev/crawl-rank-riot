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
import { computeNextScanAt } from "../utils/scheduler";
import { processAuditScan, createScanSnapshot as createScanSnapshotShared } from "../services/scan-runner";

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

      // Guard against concurrent scans for the same project
      const { data: existingScans } = await supabase
        .from("scans")
        .select("id")
        .eq("project_id", project_id)
        .eq("status", "in_progress")
        .limit(1);

      if (existingScans && existingScans.length > 0) {
        return next(
          new AppError(
            "A scan is already in progress for this project. Please wait for it to complete.",
            "SCAN_IN_PROGRESS",
            undefined,
            409,
          ),
        );
      }

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

      // Guard against concurrent scans for the same project
      const { data: existingScans } = await supabase
        .from("scans")
        .select("id")
        .eq("project_id", project_id)
        .eq("status", "in_progress")
        .limit(1);

      if (existingScans && existingScans.length > 0) {
        return next(
          new AppError(
            "A scan is already in progress for this project. Please wait for it to complete.",
            "SCAN_IN_PROGRESS",
            undefined,
            409,
          ),
        );
      }

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

const createScanSnapshot = createScanSnapshotShared;

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
    await storeScanResults(projectId, scanId, scanResults, {
      crawlCompleted: crawler.crawlCompleted,
    });

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

    // Update scan as completed — merge into existing summary_stats to preserve progress data
    const supabase = getSupabaseServiceClient();
    const completedAt = new Date().toISOString();
    const totalIssues = issuesFound + siteIssuesFound;

    const totalLinksScanned = scanResults.reduce(
      (total, page) => total + page.internal_links.length + page.external_links.length,
      0,
    );

    const { data: existingScan } = await supabase
      .from("scans")
      .select("started_at, summary_stats")
      .eq("id", scanId)
      .single();

    const mergedStats = {
      ...(typeof existingScan?.summary_stats === "object" && existingScan.summary_stats !== null
        ? existingScan.summary_stats as Record<string, unknown>
        : {}),
      ...(siteLevelData && { site_level_data: siteLevelData }),
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

    // Create a snapshot for historical trends
    await createScanSnapshot(
      projectId,
      scanId,
      scanResults.length,
      totalIssues,
      existingScan?.started_at || completedAt,
      completedAt,
    );

    // Update project: last_scan_at and recalculate next_scan_at
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
    await supabase
      .from("projects")
      .update(projectUpdate)
      .eq("id", projectId);

    console.log(
      `SEO scan completed for project ${projectId}, scan ${scanId}, ${totalIssues} issues found (${siteIssuesFound} site-level), ${backlinksFound} backlinks discovered`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null
        ? JSON.stringify(error)
        : String(error);
    console.error(`Error in SEO scan process for scan ${scanId}:`, errorMessage, error);

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
        break;
      } catch (dbError) {
        console.error(
          `Failed to update scan ${scanId} status to failed (attempt ${attempt + 1}/3):`,
          dbError,
        );
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
}

async function processAuditScanInBackground(
  url: string,
  options: any,
  scanId: string,
  projectId: string,
): Promise<void> {
  return processAuditScan(url, options, scanId, projectId);
}

export default router;
