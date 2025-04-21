import { Router, Request, Response, NextFunction } from "express";
import {
  createSuccessResponse,
  createErrorResponse,
  errorHandlerMiddleware,
} from "../services/api/responses";
import { getSupabaseClient } from "../services/database/client";
import { AppError, createValidationError, handleError } from "../utils/error";
import { crawlWebsite } from "../services/crawler";
import { storeScanResults } from "../services/database";

const router = Router();

/**
 * Validates request body for the scan endpoint
 * @param req Express request
 * @throws ValidationError if request is invalid
 */
function validateScanRequest(req: Request): void {
  const { project_id, email, options } = req.body;

  if (!project_id) {
    throw createValidationError("Project ID is required");
  }

  if (!email) {
    throw createValidationError("Email is required");
  }
}

/**
 * POST /api/scan - Start a new website scan
 */
router.post(
  "/scan",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { project_id, email, options } = req.body;

      // Validate inputs
      validateScanRequest(req);

      const supabase = getSupabaseClient();

      // Fetch project information from the database
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

      const url = project.url;

      // Log the scan request
      console.log(
        `Scan request received for Project ID: ${project_id}, URL: ${url}, Email: ${email}`,
      );

      // Create a new scan record
      const { data: scanData, error: scanError } = await supabase
        .from("scans")
        .insert({
          project_id: project_id,
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

      // Update the project's last_scan_at timestamp
      await supabase
        .from("projects")
        .update({ last_scan_at: new Date().toISOString() })
        .eq("id", project_id);

      // Parse crawler options with defaults
      const crawlerOptions = {
        maxDepth: options?.maxDepth || 10,
        maxPages: options?.maxPages || 1000,
        concurrentRequests: options?.concurrentRequests || 5,
        timeout: options?.timeout || 120000, // 2 minutes
        useHeadlessBrowser: options?.useHeadlessBrowser || true,
        checkSitemaps: options?.checkSitemaps !== false,
      };

      // Return early response to client to avoid timeout
      res.json(
        createSuccessResponse(
          {
            project_id,
            scan_id: scanId,
            url,
          },
          "Scan started successfully",
        ),
      );

      // Run the crawler in the background
      processScanInBackground(url, crawlerOptions, scanId, project_id);
    } catch (error) {
      next(handleError(error, "Error in scan endpoint"));
    }
  },
);

/**
 * Processes a scan in the background
 * @param url URL to scan
 * @param options Crawler options
 * @param scanId Scan ID
 * @param projectId Project ID
 */
async function processScanInBackground(
  url: string,
  options: any,
  scanId: string,
  projectId: string,
): Promise<void> {
  try {
    console.error(`[BACKGROUND] Starting crawl for ${url}`);
    console.error(
      `[BACKGROUND] Detailed Options: ${JSON.stringify(options, null, 2)}`,
    );

    // Run the crawler
    const scanResults = await crawlWebsite(
      url,
      {
        ...options,
      },
      scanId,
      projectId,
    );

    console.log(
      `Crawl completed for ${url}, found ${scanResults.length} pages`,
    );

    // Store all the scan results in the database
    await storeScanResults(projectId, scanId, scanResults);

    // Log completion
    console.log(
      `Scan completed for project ${projectId}, scan ${scanId}, processed ${scanResults.length} pages`,
    );
  } catch (error) {
    // Log error
    console.error(`Error in scan process for scan ${scanId}:`, error);

    // Mark scan as failed
    const supabase = getSupabaseClient();

    if (supabase) {
      await supabase
        .from("scans")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", scanId);
    }
  }
}

// Apply error handler middleware
router.use(errorHandlerMiddleware);

export default router;
