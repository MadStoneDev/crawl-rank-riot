import { Router } from "express";
import scanRouter from "./scan";
// Import but don't use authMiddleware for now
// import { authMiddleware } from "../middleware/auth";

const router = Router();

// Use scan routes without auth for testing
router.use("/", scanRouter);

// Comment out the authenticated version for now
// router.use('/', authMiddleware, scanRouter);

export default router;
