import { Router, Request, Response } from "express";
import { scanWebsite } from "../services/scan";

const router = Router();

router.post("/scan", async (req: Request, res: Response) => {
  try {
    const { url, email } = req.body;

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

    // Set a timeout to prevent scans from hanging indefinitely
    const scanTimeout = 30000; // 30 seconds
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Scan timeout exceeded")), scanTimeout);
    });

    // Call the scan service with a timeout
    const scanPromise = scanWebsite(url);
    const scanResult = await Promise.race([scanPromise, timeoutPromise]);

    // Return the scan results
    return res.json({
      status: "success",
      message: "Website scan completed",
      data: {
        url,
        email,
        scan_results: scanResult,
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
