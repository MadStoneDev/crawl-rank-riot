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

    // Call the scan service
    const scanResult = await scanWebsite(url);

    // Return the scan results
    return res.json({
      status: "success",
      message: "Website scan completed",
      data: {
        url,
        email,
        wordCount: scanResult.words.length,
        words: scanResult.words,
        imageCount: scanResult.images.length,
        images: scanResult.images,
        linkCount: scanResult.links.length,
        links: scanResult.links,
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
