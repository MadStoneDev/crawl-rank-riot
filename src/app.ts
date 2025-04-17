import express, { Request, Response } from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

const allowedOrigins = ["https://rankriot.app", "http://localhost:3123"];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    credentials: true,
  }),
);

// Simple test endpoint
app.get("/api/test", (req: Request, res: Response) => {
  res.json({
    status: "success",
    message: "Backend API is working!",
  });
});

// Simple test endpoint
app.post("/api/test", (req: Request, res: Response) => {
  try {
    const { url, email } = req.body;

    if (!url || !email) {
      return res.status(400).json({ error: "URL and email are required" });
    }

    res.json({
      status: "success",
      message: "Data received successfully",
      data: {
        url,
        email,
      },
    });
  } catch (error) {
    console.error("Unexpected error during test endpoint:", error);
    res.status(500).json({
      error: "An unexpected error occurred. Please try again.",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
