import { AppError } from "../utils/error";
import { getSupabaseServiceClient } from "../services/database/client";
import { Router, Request, Response, NextFunction } from "express";
import {
  createSuccessResponse,
  errorHandlerMiddleware,
} from "../services/api/responses";
import { AuthenticatedRequest } from "../middleware/auth";
import { parseProjectSettings } from "../utils/project-settings";
import { runScanPipeline } from "../services/scan-pipeline";

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
        .select("id, url, user_id, settings")
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

      // Per-project advanced configuration (custom sitemaps, exclusions, etc.)
      const projectSettings = parseProjectSettings(project.settings, project.url);

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
        ...projectSettings.crawlOverrides,
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
      runScanPipeline("seo", project.url, crawlerOptions, scanId, project_id);
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
        .select("id, url, user_id, settings")
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

      // Per-project advanced configuration (custom sitemaps, key pages, etc.)
      const projectSettings = parseProjectSettings(project.settings, project.url);

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
        ...projectSettings.crawlOverrides,
        // Custom key page paths feed the audit completeness analyzer
        keyPages: projectSettings.keyPages,
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
      runScanPipeline("audit", project.url, crawlerOptions, scanId, project_id);
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


export default router;
