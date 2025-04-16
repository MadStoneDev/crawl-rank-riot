import express from "express";
import { Request, Response } from "express";
import * as scanner from "../services/scanner";
import logger from "../utils/logger";

const router = express.Router();

// Webhook for Supabase to notify about new projects
router.post("/project-created", async (req: Request, res: Response) => {
  try {
    const { project_id } = req.body;

    if (!project_id) {
      return res.status(400).json({ error: "Project ID is required" });
    }

    logger.info(`Received webhook for project creation: ${project_id}`);

    // Queue a scan for the new project
    const scan = await scanner.queueScan(project_id);

    res
      .status(200)
      .json({ message: "Scan queued successfully", scan_id: scan.id });
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error in project-created webhook:", error.message);
      res.status(500).json({ error: error.message });
    } else {
      logger.error("Unknown error in project-created webhook");
      res.status(500).json({ error: "An unknown error occurred" });
    }
  }
});

export default router;
