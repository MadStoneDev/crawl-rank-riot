import dotenv from "dotenv";
import { CrawlOptions } from "../types";

dotenv.config();

interface Config {
  port: number;
  nodeEnv: string;
  supabase: {
    url: string;
    serviceKey: string;
  };
  crawler: CrawlOptions;
  mailersend: {
    apiKey: string;
    enabled: boolean;
  };
  scanFrequencies: {
    daily: string;
    weekly: string;
    monthly: string;
  };
}

const config: Config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  supabase: {
    url: process.env.SUPABASE_URL || "",
    serviceKey: process.env.SUPABASE_SERVICE_KEY || "",
  },
  crawler: {
    concurrency: 3,
    timeout: 30000, // 30 seconds
    delay: 1000, // 1 second between requests
    maxPages: 100, // Default page limit
    respectRobotsTxt: true,
  },
  mailersend: {
    apiKey: process.env.MAILERSEND_API_TOKEN || "",
    enabled: process.env.MAILERSEND_ENABLED === "true",
  },
  scanFrequencies: {
    daily: "0 0 * * *", // Run at midnight every day
    weekly: "0 0 * * 0", // Run at midnight every Sunday
    monthly: "0 0 1 * *", // Run at midnight on the 1st of each month
  },
};

// Validate required environment variables
if (!config.supabase.url || !config.supabase.serviceKey) {
  throw new Error("Missing required environment variables for Supabase");
}

export default config;
