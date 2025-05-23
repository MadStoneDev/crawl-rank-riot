import { Router } from "express";
import scanRouter from "./scan"; // Make sure this path is correct
// import { authMiddleware } from '../middleware/auth';

const router = Router();

// Health check route (no auth required)
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "2.0.0",
  });
});

// Scan routes (uncomment authMiddleware when ready)
router.use("/", scanRouter);
// router.use('/', authMiddleware, scanRouter);

export default router;
