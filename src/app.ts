import cors from "cors";
import express, { Request, Response, NextFunction } from "express";

import config from "./config";
import logger from "./utils/logger";
import apiRoutes from "./routes/api";
import webhookRoutes from "./routes/webhooks";

const app = express();

// Middleware
app.use(express.json());

app.use(
  cors({
    origin: [
      "https://rankriot.app",
      "http://localhost:3123",
      "https://crawl.rankriot.app",
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Simple request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});

// Routes
app.use("/api", apiRoutes);
app.use("/webhooks", webhookRoutes);

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.status(200).send({ status: "ok" });
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error(err.stack);
  res.status(500).send({
    error: "Internal Server Error",
    message: config.nodeEnv === "development" ? err.message : undefined,
  });
});

export default app;
