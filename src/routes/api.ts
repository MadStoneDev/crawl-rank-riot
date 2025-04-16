import express from "express";
import { Request, Response } from "express";
import * as scanner from "../services/scanner";

const router = express.Router();

// Start a new scan for a project
router.post("/scan", async (req: Request, res: Response) => {
  try {
    const { project_id } = req.body;

    if (!project_id) {
      return res.status(400).json({ error: "Project ID is required" });
    }

    const scan = await scanner.queueScan(project_id);
    res.status(201).json(scan);
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred" });
    }
  }
});

// Get scan status
router.get("/scan/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const scan = await scanner.getScanStatus(id);

    if (!scan) {
      return res.status(404).json({ error: "Scan not found" });
    }

    res.status(200).json(scan);
  } catch (error) {
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred" });
    }
  }
});

export default router;
