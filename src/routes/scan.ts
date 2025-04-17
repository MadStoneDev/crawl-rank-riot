import { Router, Request, Response } from "express";

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

import { crawlWebsite } from "../services/crawler";
import { storeScanResults } from "../services/database";

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
      return res.status(500).json({
        status: "error",
        message: "Failed to create scan record",
        details: scanError,
      });
    }

    const scanId = scanData.id;

    // Update the project's last_scan_at timestamp
    await supabase
      .from("projects")
      .update({ last_scan_at: new Date().toISOString() })
      .eq("id", project_id);

    // Parse crawler options with defaults
    const crawlerOptions = {
      maxDepth: options?.maxDepth || 3,
      maxPages: options?.maxPages || 100,
      concurrentRequests: options?.concurrentRequests || 5,
      timeout: options?.timeout || 120000, // 2 minutes
    };

    // Return early response to client to avoid timeout
    res.json({
      status: "success",
      message: "Scan started successfully",
      data: {
        project_id,
        scan_id: scanId,
        url,
      },
    });

    try {
      // Run the crawler in the background
      const scanResults = await crawlWebsite(
        url,
        crawlerOptions,
        scanId,
        project_id,
      );

      // Store all the scan results in the database
      await storeScanResults(project_id, scanId, scanResults);

      // Log completion
      console.log(
        `Scan completed for project ${project_id}, scan ${scanId}, processed ${scanResults.length} pages`,
      );
    } catch (error) {
      // Mark scan as failed if any error occurs
      console.error(`Error in scan process for scan ${scanId}:`, error);

      await supabase
        .from("scans")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", scanId);
    }
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
