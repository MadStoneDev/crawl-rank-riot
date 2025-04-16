import * as cron from "node-cron";
import { supabase } from "../db/supabase";
import * as scanner from "./scanner";
import config from "../config";
import logger from "../utils/logger";

// Initialize the scheduler for automatic scans
export async function initScheduler(): Promise<void> {
  try {
    logger.info("Initializing scheduler for automatic scans");

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

    logger.info("Scheduler initialized");
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error initializing scheduler: ${error.message}`);
    } else {
      logger.error("Unknown error initializing scheduler");
    }
  }
}

// Schedule scans for projects with a specific frequency
async function scheduleFrequencyScans(frequency: string): Promise<void> {
  try {
    logger.info(`Scheduling ${frequency} scans`);

    // Get all projects with this frequency
    const { data: projects, error } = await supabase
      .from("projects")
      .select("id")
      .eq("scan_frequency", frequency);

    if (error) {
      throw new Error(`Error getting ${frequency} projects: ${error.message}`);
    }

    if (!projects || projects.length === 0) {
      logger.info(`No projects found with ${frequency} scan frequency`);
      return;
    }

    // Queue a scan for each project
    for (const project of projects) {
      try {
        await scanner.queueScan(project.id);
        logger.info(`Queued ${frequency} scan for project ${project.id}`);
      } catch (err) {
        if (err instanceof Error) {
          logger.error(
            `Error queueing ${frequency} scan for project ${project.id}: ${err.message}`,
          );
        } else {
          logger.error(
            `Unknown error queueing ${frequency} scan for project ${project.id}`,
          );
        }
      }
    }

    logger.info(`Scheduled ${projects.length} ${frequency} scans`);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error scheduling ${frequency} scans: ${error.message}`);
    } else {
      logger.error(`Unknown error scheduling ${frequency} scans`);
    }
  }
}
