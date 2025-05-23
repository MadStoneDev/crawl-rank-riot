import { AppError } from "../utils/error";
import { WebCrawler } from "../services/crawler";
import { storeScanResults } from "../services/database";
import { getSupabaseClient } from "../services/database/client";
import { Router, Request, Response, NextFunction } from "express";
import {
  createSuccessResponse,
  errorHandlerMiddleware,
} from "../services/api/responses";

const router = Router();

/**
 * POST /api/test-crawl - Test crawling without saving to database
 * Use this endpoint to test the crawler functionality
 */
router.post(
  "/test-crawl",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { url, options = {} } = req.body;

      // Validate URL
      if (!url) {
        return next(
          new AppError("URL is required", "VALIDATION_ERROR", undefined, 400),
        );
      }

      // Validate URL format
      try {
        new URL(url.startsWith("http") ? url : `https://${url}`);
      } catch {
        return next(
          new AppError(
            "Invalid URL format",
            "VALIDATION_ERROR",
            undefined,
            400,
          ),
        );
      }

      console.log(`Test crawl request received for URL: ${url}`);

      // Parse crawler options with defaults for testing
      const crawlerOptions = {
        maxDepth: options?.maxDepth || 2, // Smaller depth for testing
        maxPages: options?.maxPages || 10, // Fewer pages for testing
        concurrentRequests: options?.concurrentRequests || 2, // Lower concurrency for testing
        timeout: options?.timeout || 60000, // 1 minute timeout
        excludePatterns: [
          /\.(jpg|jpeg|png|gif|svg|webp|pdf|doc|docx|xls|xlsx|zip|tar)$/i,
          /\/(wp-admin|wp-includes|wp-content\/plugins)\//i,
          /#.*/i,
          /\?s=/i,
          /\?p=\d+/i,
          /\?(utm_|fbclid|gclid)/i,
        ],
      };

      const startTime = Date.now();

      // Run the crawler
      const crawler = new WebCrawler(url);
      const results = await crawler.crawl(url, crawlerOptions);

      const endTime = Date.now();
      const crawlDuration = endTime - startTime;

      console.log(
        `Test crawl completed for ${url}: ${results.length} pages in ${crawlDuration}ms`,
      );

      // Calculate summary statistics
      const summary = {
        totalPages: results.length,
        totalInternalLinks: results.reduce(
          (sum, page) => sum + page.internal_links.length,
          0,
        ),
        totalExternalLinks: results.reduce(
          (sum, page) => sum + page.external_links.length,
          0,
        ),
        totalImages: results.reduce((sum, page) => sum + page.images.length, 0),
        avgLoadTime:
          results.length > 0
            ? results.reduce((sum, page) => sum + (page.load_time_ms || 0), 0) /
              results.length
            : 0,
        statusCodes: results.reduce(
          (acc, page) => {
            acc[page.status] = (acc[page.status] || 0) + 1;
            return acc;
          },
          {} as Record<number, number>,
        ),
        scanMethods: results.reduce(
          (acc, page) => {
            const method = page.scan_method || "http";
            acc[method] = (acc[method] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
        crawlDurationMs: crawlDuration,
      };

      // Return detailed response for testing
      res.json(
        createSuccessResponse(
          {
            summary,
            pages: results,
            crawlOptions: crawlerOptions,
            metadata: {
              crawledAt: new Date().toISOString(),
              seedUrl: url,
              userAgent: "RankRiot/1.0 SEO Crawler",
            },
          },
          `Test crawl completed successfully. Found ${results.length} pages.`,
        ),
      );
    } catch (error) {
      console.error("Error in test crawl:", error);
      next(error);
    }
  },
);

/**
 * POST /api/scan - Start a new website scan
 */
router.post(
  "/scan",
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

      const supabase = getSupabaseClient();

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
        `Scan request received for Project ID: ${project_id}, URL: ${project.url}, Email: ${email}`,
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

      // Update project's last_scan_at timestamp
      await supabase
        .from("projects")
        .update({ last_scan_at: new Date().toISOString() })
        .eq("id", project_id);

      // Parse crawler options with defaults
      const crawlerOptions = {
        maxDepth: options?.maxDepth || 3,
        maxPages: options?.maxPages || 100,
        concurrentRequests: options?.concurrentRequests || 3,
        timeout: options?.timeout || 120000, // 2 minutes
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
          },
          "Scan started successfully",
        ),
      );

      // Run the crawler in the background
      processScanInBackground(project.url, crawlerOptions, scanId, project_id);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/scan/:scanId - Get scan status and results
 */
router.get(
  "/scan/:scanId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scanId } = req.params;
      const supabase = getSupabaseClient();

      const { data: scan, error } = await supabase
        .from("scans")
        .select("*")
        .eq("id", scanId)
        .single();

      if (error || !scan) {
        return next(
          new AppError("Scan not found", "SCAN_NOT_FOUND", error, 404),
        );
      }

      // If scan is completed, also fetch the pages
      let pages: any[] = [];
      if (scan.status === "completed") {
        const { data: pagesData } = await supabase
          .from("pages")
          .select("*")
          .eq("project_id", scan.project_id)
          .order("created_at", { ascending: false })
          .limit(scan.pages_scanned || 100);

        pages = pagesData || [];
      }

      res.json(
        createSuccessResponse({
          scan,
          pages: scan.status === "completed" ? pages : [],
        }),
      );
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Processes a scan in the background
 */
async function processScanInBackground(
  url: string,
  options: any,
  scanId: string,
  projectId: string,
): Promise<void> {
  try {
    console.log(`Starting background crawl for ${url}`);

    const crawler = new WebCrawler(url);
    const scanResults = await crawler.crawl(url, options);

    console.log(
      `Crawl completed for ${url}, found ${scanResults.length} pages`,
    );

    // Store all the scan results in the database
    await storeScanResults(projectId, scanId, scanResults);

    // Mark scan as completed
    const supabase = getSupabaseClient();
    await supabase
      .from("scans")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        pages_scanned: scanResults.length,
        links_scanned: scanResults.reduce(
          (total, page) =>
            total + page.internal_links.length + page.external_links.length,
          0,
        ),
      })
      .eq("id", scanId);

    console.log(
      `Scan completed for project ${projectId}, scan ${scanId}, processed ${scanResults.length} pages`,
    );
  } catch (error) {
    console.error(`Error in scan process for scan ${scanId}:`, error);

    // Mark scan as failed
    const supabase = getSupabaseClient();
    await supabase
      .from("scans")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", scanId);
  }
}

router.use(errorHandlerMiddleware);

export default router;
