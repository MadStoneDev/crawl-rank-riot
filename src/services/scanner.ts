import * as cron from "node-cron";
import { v4 as uuidv4 } from "uuid";

import { supabase } from "../db/supabase";
import { Scan, Project } from "../types";

import config from "../config";
import logger from "../utils/logger";
import * as crawler from "./crawler";
import { sendCompletionEmail } from "./notifications";

// Map to track active scans
const activeScans = new Map<string, boolean>();

/**
 * Updates the queue positions of all queued scans
 * This ensures proper queue order is maintained when scans are added/removed
 */
async function updateQueuePositions(): Promise<void> {
  try {
    // Get all queued scans ordered by current position and creation date as fallback
    const { data: queuedScans, error } = await supabase
      .from("scans")
      .select("id")
      .eq("status", "queued")
      .order("queue_position", { ascending: true })
      .order("created_at", { ascending: true });

    if (error || !queuedScans) {
      throw new Error(`Error getting queued scans: ${error?.message}`);
    }

    // Update each scan with its new position
    for (let i = 0; i < queuedScans.length; i++) {
      const { error: updateError } = await supabase
        .from("scans")
        .update({ queue_position: i })
        .eq("id", queuedScans[i].id);

      if (updateError) {
        logger.warn(
          `Error updating queue position for scan ${queuedScans[i].id}: ${updateError.message}`,
        );
      }
    }

    logger.debug(`Updated queue positions for ${queuedScans.length} scans`);
  } catch (error) {
    logger.error(`Error updating queue positions: ${error}`);
  }
}

/**
 * Queue a new scan for a project
 */
export async function queueScan(projectId: string): Promise<Scan> {
  try {
    // Get the project
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .single();

    if (projectError || !project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Check for ongoing scans for this project
    const { data: ongoingScans, error: scanError } = await supabase
      .from("scans")
      .select("id")
      .eq("project_id", projectId)
      .in("status", ["queued", "in_progress"])
      .order("created_at", { ascending: true });

    if (scanError) {
      throw new Error(`Error checking for ongoing scans: ${scanError.message}`);
    }

    // Count the total number of queued scans to determine position
    const { count, error: countError } = await supabase
      .from("scans")
      .select("*", { count: "exact", head: true })
      .eq("status", "queued");

    if (countError) {
      throw new Error(`Error getting queue count: ${countError.message}`);
    }

    // Create a new scan
    const scanId = uuidv4();
    const queue_position = count || 0;

    const newScan: any = {
      id: scanId,
      project_id: projectId,
      status: "queued",
      queue_position,
      pages_scanned: 0,
      links_scanned: 0,
      issues_found: 0,
    };

    const { data: scan, error: insertError } = await supabase
      .from("scans")
      .insert(newScan)
      .select()
      .single();

    if (insertError || !scan) {
      throw new Error(`Error creating scan: ${insertError?.message}`);
    }

    logger.info(
      `Queued new scan ${scanId} for project ${projectId} at position ${queue_position}`,
    );

    // If no ongoing scans for this project, and no other scans in the queue,
    // start this one immediately
    if (ongoingScans?.length === 0 && queue_position === 0) {
      // Start scan process in the background
      startScan(scanId).catch((err) => {
        logger.error(`Error in background scan process: ${err}`);
      });
    }

    return scan;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Unknown error queueing scan");
  }
}

/**
 * Update scan progress during crawling
 */
export async function updateScanProgress(
  scanId: string,
  pagesScanned: number,
  linksScanned: number,
  issuesFound: number,
): Promise<void> {
  try {
    await supabase
      .from("scans")
      .update({
        pages_scanned: pagesScanned,
        links_scanned: linksScanned,
        issues_found: issuesFound,
        last_progress_update: new Date().toISOString(),
      })
      .eq("id", scanId);

    logger.debug(
      `Updated progress for scan ${scanId}: ${pagesScanned} pages, ${linksScanned} links, ${issuesFound} issues`,
    );
  } catch (error) {
    logger.error(`Error updating scan progress: ${error}`);
  }
}

/**
 * Start a scan with the given ID
 */
export async function startScan(scanId: string): Promise<void> {
  // If scan is already running, ignore
  if (activeScans.has(scanId)) {
    logger.warn(
      `Scan ${scanId} is already active, ignoring duplicate start request`,
    );
    return;
  }

  try {
    // Mark scan as active
    activeScans.set(scanId, true);

    // Get the scan with project information
    const { data: scan, error: scanError } = await supabase
      .from("scans")
      .select("*, projects(*)")
      .eq("id", scanId)
      .single();

    if (scanError || !scan) {
      throw new Error(`Scan not found: ${scanId}`);
    }

    // Update scan status to in_progress
    await supabase
      .from("scans")
      .update({
        status: "in_progress",
        started_at: new Date().toISOString(),
        queue_position: null,
        pages_scanned: 0,
        links_scanned: 0,
        issues_found: 0,
        last_progress_update: new Date().toISOString(),
      })
      .eq("id", scanId);

    // Update queue positions after removing this scan from the queue
    await updateQueuePositions();

    logger.info(`Starting scan ${scanId} for project ${scan.project_id}`);

    // Start the crawler
    await crawler.startCrawl(scan);

    // Update scan status to completed
    await supabase
      .from("scans")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", scanId);

    // Email the user if they have an email address
    if (scan.projects.notification_email) {
      const issuesResult = await supabase
        .from("issues")
        .select("*", { count: "exact", head: true })
        .eq("scan_id", scanId);

      const issueCount = issuesResult.count || 0;

      await sendCompletionEmail(
        scan.projects.notification_email,
        scan.projects.name,
        scanId,
        issueCount,
      );
    }

    // Update the project's last_scan_at
    await supabase
      .from("projects")
      .update({
        last_scan_at: new Date().toISOString(),
      })
      .eq("id", scan.project_id);

    logger.info(`Completed scan ${scanId} for project ${scan.project_id}`);

    // Process the next scan in queue
    await processNextInQueue();
  } catch (error) {
    // Update scan status to failed
    await supabase
      .from("scans")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : "Unknown error",
      })
      .eq("id", scanId);

    if (error instanceof Error) {
      logger.error(`Error in scan ${scanId}: ${error.message}`);
    } else {
      logger.error(`Unknown error in scan ${scanId}`);
    }

    // Still try to process the next scan in queue
    await processNextInQueue();
  } finally {
    // Remove from active scans
    activeScans.delete(scanId);
  }
}

/**
 * Get the status of a scan
 */
export async function getScanStatus(scanId: string): Promise<Scan | null> {
  try {
    const { data, error } = await supabase
      .from("scans")
      .select("*")
      .eq("id", scanId)
      .single();

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    logger.error(`Error getting scan status: ${error}`);
    return null;
  }
}

/**
 * Process the next scan in the queue
 */
async function processNextInQueue(): Promise<void> {
  try {
    // Find the next queued scan based on queue position
    const { data: nextScans, error } = await supabase
      .from("scans")
      .select("id")
      .eq("status", "queued")
      .order("queue_position", { ascending: true })
      .limit(1);

    if (error || !nextScans || nextScans.length === 0) {
      return; // No more scans to process
    }

    const nextScanId = nextScans[0].id;

    // Add a small delay to avoid race conditions
    setTimeout(() => {
      startScan(nextScanId).catch((err) => {
        logger.error(`Error starting next scan: ${err}`);
      });
    }, 1000);
  } catch (error) {
    logger.error(`Error processing next scan in queue: ${error}`);
  }
}

/**
 * Check for abandoned scans (scans that are in_progress but have been
 * running for too long) and mark them as failed
 */
async function handleAbandonedScans(): Promise<void> {
  try {
    // Look for scans that have been in progress for over 2 hours
    const twoHoursAgo = new Date();
    twoHoursAgo.setHours(twoHoursAgo.getHours() - 2);

    const { data: abandonedScans, error } = await supabase
      .from("scans")
      .select("id")
      .eq("status", "in_progress")
      .lt("started_at", twoHoursAgo.toISOString());

    if (error) {
      throw new Error(`Error finding abandoned scans: ${error.message}`);
    }

    if (abandonedScans && abandonedScans.length > 0) {
      logger.warn(
        `Found ${abandonedScans.length} abandoned scans, marking as failed`,
      );

      for (const scan of abandonedScans) {
        await supabase
          .from("scans")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: "Scan timed out",
          })
          .eq("id", scan.id);

        // Remove from active scans if it's there
        activeScans.delete(scan.id);
      }

      // Process the next scan if we cleared out some abandoned ones
      await processNextInQueue();
    }
  } catch (error) {
    logger.error(`Error handling abandoned scans: ${error}`);
  }
}

/**
 * Initialize the scheduler for automatic scans
 */
export async function initScheduler(): Promise<void> {
  try {
    logger.info("Initializing scheduler for automatic scans");

    // Check for abandoned scans every 15 minutes
    cron.schedule("*/15 * * * *", async () => {
      await handleAbandonedScans();
    });

    // Schedule daily scans
    cron.schedule(config.scanFrequencies.daily, async () => {
      await scheduleFrequencyScans("daily");
    });

    // Schedule weekly scans
    cron.schedule(config.scanFrequencies.weekly, async () => {
      await scheduleFrequencyScans("weekly");
    });

    // Schedule monthly scans
    cron.schedule(config.scanFrequencies.monthly, async () => {
      await scheduleFrequencyScans("monthly");
    });

    // Process any pending scans on startup
    setTimeout(async () => {
      logger.info("Processing any pending scans from before server restart");
      await processNextInQueue();
    }, 5000);

    logger.info("Scheduler initialized");
  } catch (error) {
    logger.error(`Error initializing scheduler: ${error}`);
  }
}

/**
 * Schedule scans for projects with a specific frequency
 */
async function scheduleFrequencyScans(frequency: string): Promise<void> {
  try {
    logger.info(`Scheduling ${frequency} scans`);

    // Get all projects with this frequency
    const { data: projects, error } = await supabase
      .from("projects")
      .select("id")
      .eq("scan_frequency", frequency);

    if (error || !projects) {
      throw new Error(`Error getting ${frequency} projects: ${error?.message}`);
    }

    // Queue a scan for each project
    for (const project of projects) {
      try {
        await queueScan(project.id);
      } catch (err) {
        logger.error(
          `Error queueing ${frequency} scan for project ${project.id}: ${err}`,
        );
      }
    }

    logger.info(`Scheduled ${projects.length} ${frequency} scans`);
  } catch (error) {
    logger.error(`Error scheduling ${frequency} scans: ${error}`);
  }
}
