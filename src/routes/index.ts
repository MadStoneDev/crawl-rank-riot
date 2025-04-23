import { Router } from "express";
import scanRouter from "./scan";
import { authMiddleware } from "../middleware/auth";

const router = Router();
router.use("/", authMiddleware, scanRouter);

export default router;
