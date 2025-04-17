import express from "express";
import { Request, Response } from "express";
import * as scanner from "../services/scanner";
import logger from "../utils/logger";

const router = express.Router();

// Start a new scan for a project
router.post("/scan", async (req: Request, res: Response) => {
  try {
    const { project_id, notification_email } = req.body;

    if (!project_id) {
      logger.warn("Scan request missing project_id");
      return res.status(400).json({ error: "Project ID is required" });
    }

    // Log the incoming request
    logger.info(`Starting scan for project ${project_id}`);

    // Queue the scan
    try {
      const scan = await scanner.queueScan(project_id, notification_email);
      logger.info(`Scan queued successfully: ${scan.id}`);

      // Set content type explicitly
      res.setHeader("Content-Type", "application/json");
      return res.status(201).json({
        message: "Scan queued successfully",
        id: scan.id,
        status: scan.status,
        queue_position: scan.queue_position,
      });
    } catch (scanError) {
      // Log detailed error but return clean message
      logger.error(`Error queueing scan: ${scanError}`);

      // Set content type explicitly
      res.setHeader("Content-Type", "application/json");
      return res.status(500).json({
        error: "Failed to start scan",
        message:
          scanError instanceof Error ? scanError.message : String(scanError),
      });
    }
  } catch (error) {
    // Handle unexpected errors
    logger.error(`Unhandled error in scan endpoint: ${error}`);

    // Set content type explicitly
    res.setHeader("Content-Type", "application/json");
    return res.status(500).json({
      error: "An unexpected error occurred",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get scan status
router.get("/scan/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "Scan ID is required" });
    }

    logger.info(`Getting status for scan ${id}`);

    const scan = await scanner.getScanStatus(id);

    if (!scan) {
      logger.info(`Scan not found: ${id}`);
      return res.status(404).json({ error: "Scan not found" });
    }

    return res.status(200).json(scan);
  } catch (error) {
    logger.error(`Error getting scan status: ${error}`);

    // Set content type explicitly
    res.setHeader("Content-Type", "application/json");
    return res.status(500).json({
      error: "Failed to get scan status",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
