import { Router } from "express";
import scanRouter from "./scan";
import { authMiddleware } from "../middleware/auth";

const router = Router();

// Public routes (no auth required)
router.get("/health", (req, res) => res.json({ status: "healthy" }));

// Protected routes (auth required)
// Apply auth middleware to all scan routes
router.use("/", authMiddleware, scanRouter);

export default router;
