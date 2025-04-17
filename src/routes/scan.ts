import { Router, Request, Response } from "express";

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

import { crawlWebsite } from "../services/crawler";

// Load environment variables
dotenv.config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || "";

// Validate environment variables
if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Error: Missing required environment variables SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
  );
  // Continue execution, but log the error
}

const supabase = createClient(supabaseUrl, supabaseKey);

const router = Router();

router.post("/scan", async (req: Request, res: Response) => {
  try {
    const { project_id, email, options } = req.body;

    // Validate inputs
    if (!project_id) {
      return res.status(400).json({
        status: "error",
        message: "Project ID is required",
      });
    }

    if (!email) {
      return res.status(400).json({
        status: "error",
        message: "Email is required",
      });
    }

    // Fetch project information from the database
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, url")
      .eq("id", project_id)
      .single();

    if (projectError || !project) {
      return res.status(404).json({
        status: "error",
        message: "Project not found",
        details: projectError,
      });
    }

    const url = project.url;

    // Log the scan request
    console.log(
      `Scan request received for Project ID: ${project_id}, URL: ${url}, Email: ${email}`,
    );

    // Update the project's last_scan_at timestamp
    await supabase
      .from("projects")
      .update({ last_scan_at: new Date().toISOString() })
      .eq("id", project_id);

    // Create a new scan record
    const { data: scanData, error: scanError } = await supabase
      .from("scans")
      .insert({
        project_id: project_id,
        status: "in_progress",
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (scanError) {
      return res.status(500).json({
        status: "error",
        message: "Failed to create scan record",
        details: scanError,
      });
    }

    // Parse crawler options with defaults
    const crawlerOptions = {
      maxDepth: options?.maxDepth || 3,
      maxPages: options?.maxPages || 100,
      concurrentRequests: options?.concurrentRequests || 5,
      timeout: options?.timeout || 120000, // 2 minutes
    };

    // Run the crawler
    const scanResults = await crawlWebsite(url, crawlerOptions);

    // Update the scan record with completion information
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
        summary_stats: {
          http_status_counts: countHttpStatuses(scanResults),
          indexable_pages: scanResults.filter((page) => page.is_indexable)
            .length,
          non_indexable_pages: scanResults.filter((page) => !page.is_indexable)
            .length,
          avg_page_load_time: calculateAverage(scanResults, "load_time_ms"),
          avg_word_count: calculateAverage(scanResults, "word_count"),
          total_internal_links: scanResults.reduce(
            (total, page) => total + page.internal_links.length,
            0,
          ),
          total_external_links: scanResults.reduce(
            (total, page) => total + page.external_links.length,
            0,
          ),
        },
      })
      .eq("id", scanData.id);

    // Return the scan results
    return res.json({
      status: "success",
      message: `Website crawl completed. Scanned ${scanResults.length} pages.`,
      data: {
        project_id,
        scan_id: scanData.id,
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

// Helper function to count HTTP statuses
function countHttpStatuses(pages: any[]) {
  const counts: Record<string, number> = {};
  pages.forEach((page) => {
    const status = page.http_status.toString();
    counts[status] = (counts[status] || 0) + 1;
  });
  return counts;
}

// Helper function to calculate average for a property
function calculateAverage(pages: any[], property: string) {
  if (pages.length === 0) return 0;
  const sum = pages.reduce((total, page) => total + (page[property] || 0), 0);
  return Math.round(sum / pages.length);
}

export default router;
