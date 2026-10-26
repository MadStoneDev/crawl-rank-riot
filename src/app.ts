import cors from "cors";
import rateLimit from "express-rate-limit";
import routes from "./routes/index"; // Updated path to point to routes/index.ts
import v1Routes from "./routes/v1/index";
import { config, validateConfig } from "./config";
import { crawlScheduler } from "./utils/scheduler";
import { beginShutdown } from "./utils/lifecycle";
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

// Behind Coolify's reverse proxy the real client IP is in X-Forwarded-For.
// Trust a fixed number of proxy hops so req.ip resolves to the actual client and
// the rate limiters key per client instead of lumping all traffic under the
// proxy's single IP. A fixed count (not `true`) avoids X-Forwarded-For spoofing.
// Default 1 (single proxy); override with TRUST_PROXY_HOPS if there are more.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
app.set(
  "trust proxy",
  Number.isFinite(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1,
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Public /api/v1 jobs API (Stage 3). Mounted BEFORE the IP rate limiters and
// the JWT-protected /api router so it is governed solely by its own API-key
// auth and per-key rate limiter. API keys are for server-to-server use, so this
// deliberately sits outside the browser CORS policy below.
app.use("/api/v1", v1Routes);

// Rate limiting — general API
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// Rate limiting — scan endpoints (more restrictive)
const scanLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 scan requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many scan requests, please try again later." },
});

app.use("/api", generalLimiter);
app.use("/api/scan", scanLimiter);

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

// API routes
app.use("/api", routes);

app.use((req: Request, res: Response, next: NextFunction) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
});

app.use(errorHandlerMiddleware);

const server = app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);

  // The crawler is a single process: any scan still marked in_progress after a
  // (re)start is a ghost from the previous process that died mid-scan and is now
  // blocking its project behind the 409 scan_in_progress guard. Fail those
  // (and, via their linked scan, any "running" API jobs) BEFORE the scheduler
  // starts, so a redeploy frees projects immediately instead of after the 2-hour
  // stale reaper. Best-effort — it never throws, so boot proceeds regardless.
  await crawlScheduler.recoverInterruptedScans();

  // Start the crawl scheduler
  crawlScheduler.start();
  console.log("Automatic crawl scheduler started");
});

// Graceful shutdown. Stop accepting new scans (beginShutdown makes the scan
// entry points return 503), stop the scheduler, and best-effort mark the
// in-flight scan(s) interrupted so the next process doesn't have to wait for the
// startup reaper. Then drain HTTP connections and exit. Startup recovery is the
// real guarantee; this just shortens the window.
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down gracefully`);
  beginShutdown();
  crawlScheduler.stop();
  try {
    await crawlScheduler.recoverInterruptedScans();
  } catch (error) {
    console.error("Error marking in-flight scans interrupted on shutdown:", error);
  }
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  crawlScheduler.stop();
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

export default app;
