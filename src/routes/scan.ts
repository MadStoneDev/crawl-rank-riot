import { Router, Request, Response } from "express";
import { crawlWebsite } from "../services/crawler";

const router = Router();

router.post("/scan", async (req: Request, res: Response) => {
  try {
    const { url, email, options } = req.body;

    // Validate inputs
    if (!url) {
      return res.status(400).json({
        status: "error",
        message: "URL is required",
      });
    }

    if (!email) {
      return res.status(400).json({
        status: "error",
        message: "Email is required",
      });
    }

    // Log the scan request
    console.log(`Scan request received for URL: ${url}, Email: ${email}`);

    // Parse crawler options with defaults
    const crawlerOptions = {
      maxDepth: options?.maxDepth || 3,
      maxPages: options?.maxPages || 100,
      concurrentRequests: options?.concurrentRequests || 5,
      timeout: options?.timeout || 120000, // 2 minutes
    };

    // Run the crawler
    const scanResults = await crawlWebsite(url, crawlerOptions);

    // Return the scan results
    return res.json({
      status: "success",
      message: `Website crawl completed. Scanned ${scanResults.length} pages.`,
      data: {
        url,
        email,
        options: crawlerOptions,
        pages_scanned: scanResults.length,
        scan_results: scanResults,
      },
    });
  } catch (error) {
    console.error("Error in scan endpoint:", error);
    return res.status(500).json({
      status: "error",
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

export default router;
