import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { config, validateConfig } from "./config";
import routes from "./routes";
import { errorHandlerMiddleware } from "./services/api/responses";

// Validate required configuration
try {
  validateConfig();
} catch (error) {
  console.error("Configuration error:", error);
  process.exit(1);
}

// Initialize Express app
const app = express();
const PORT = config.server.port;

// Apply middleware
app.use(express.json());

// Configure CORS
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, etc)
      if (!origin) return callback(null, true);

      // Check against allowed origins
      if (config.server.allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"), false);
    },
    methods: ["GET", "POST"],
    credentials: true,
  }),
);

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Register routes
app.use("/api", routes);

// Catch 404 and forward to error handler
app.use((req: Request, res: Response, next: NextFunction) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
});

// Global error handler
app.use(errorHandlerMiddleware);

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});

// Handle uncaught exceptions and rejections
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Perform graceful shutdown
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // No need to exit here, just log
});

export default app;
