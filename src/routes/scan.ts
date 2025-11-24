import { AppError } from "../utils/error";
import { WebCrawler } from "../services/crawler";
import { getSupabaseServiceClient } from "../services/database/client";
import { Router, Request, Response, NextFunction } from "express";
import {
  createSuccessResponse,
  errorHandlerMiddleware,
} from "../services/api/responses";

const router = Router();

/**
 * POST /api/scan/audit - Start a new audit scan
 */
router.post(
  "/scan/audit",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { project_id, email, options = {} } = req.body;

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
      if (!email) {
        return next(
          new AppError("Email is required", "VALIDATION_ERROR", undefined, 400),
        );
      }

      const supabase = getSupabaseServiceClient();

      // Fetch project information
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, url")
        .eq("id", project_id)
        .single();

      if (projectError || !project) {
        return next(
          new AppError(
            "Project not found",
            "PROJECT_NOT_FOUND",
            projectError,
            404,
          ),
        );
      }

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

      // Audit scans can be shallower
      const crawlerOptions = {
        maxDepth: options?.maxDepth || 2,
        maxPages: options?.maxPages || 50,
        concurrentRequests: options?.concurrentRequests || 3,
        timeout: options?.timeout || 120000,
        checkSitemaps: options?.checkSitemaps !== false,
        excludePatterns: [
          /\.(jpg|jpeg|png|gif|svg|webp|pdf|doc|docx|xls|xlsx|zip|tar)$/i,
          /\/(wp-admin|wp-includes|wp-content\/plugins)\//i,
          /#.*/i,
          /\?s=/i,
          /\?p=\d+/i,
          /\?(utm_|fbclid|gclid)/i,
        ],
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
    const { AuditAnalyzer } = await import("../services/audit-analyzer");
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
    const { storeAuditResults } = await import("../services/audit-database");
    await storeAuditResults(projectId, scanId, auditData);

    // Update scan as completed
    const supabase = getSupabaseServiceClient();
    await supabase
      .from("scans")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        pages_scanned: scanResults.length,
        summary_stats: {
          overall_score: overallScore,
          recommendations_count: recommendations.length,
        },
      })
      .eq("id", scanId);

    console.log(
      `Audit scan completed for project ${projectId}, scan ${scanId}, score: ${overallScore}/100`,
    );
  } catch (error) {
    console.error(`Error in audit scan process for scan ${scanId}:`, error);

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
  }
}
