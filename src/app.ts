import cors from "cors";
import routes from "./routes";
import { config, validateConfig } from "./config";
import { crawlScheduler } from "./utils/scheduler";
import { errorHandlerMiddleware } from "./services/api/responses";
import express, { Request, Response, NextFunction } from "express";

try {
  validateConfig();
} catch (error) {
  console.error("Configuration error:", error);
  process.exit(1);
}

const app = express();
const PORT = config.server.port;

app.use(express.json());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      if (config.server.allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"), false);
    },
    methods: ["GET", "POST"],
    credentials: true,
  }),
);

app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    scheduler: crawlScheduler ? "running" : "stopped",
  });
});

app.use("/api", routes);

app.use((req: Request, res: Response, next: NextFunction) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
});

app.use(errorHandlerMiddleware);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);

  // Start the crawl scheduler
  crawlScheduler.start();
  console.log("Automatic crawl scheduler started");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  crawlScheduler.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  crawlScheduler.stop();
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  crawlScheduler.stop();
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

export default app;
