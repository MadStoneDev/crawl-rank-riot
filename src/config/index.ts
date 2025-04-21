import dotenv from "dotenv";

// Load environment variables
dotenv.config();

/**
 * Centralized application configuration
 */
export const config = {
  database: {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseKey: process.env.SUPABASE_SERVICE_KEY || "",
  },
  redis: {
    url: process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    enabled: !!(
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ),
  },
  crawler: {
    userAgent: "RankRiot/1.0 SEO Crawler",
    defaultTimeout: 30000, // 30 seconds
    maxDepth: 10,
    maxPages: 1000,
    concurrentRequests: 5,
    defaultDelay: 100, // ms between requests
    perDomainDelay: 200, // ms between requests to same domain
  },
  server: {
    port: parseInt(process.env.PORT || "3000", 10),
    allowedOrigins: ["https://rankriot.app", "http://localhost:3123"],
  },
};

/**
 * Validate essential configuration on startup
 * @throws Error if required configuration is missing
 */
export function validateConfig(): void {
  const missingVars = [];

  if (!config.database.supabaseUrl) missingVars.push("SUPABASE_URL");
  if (!config.database.supabaseKey) missingVars.push("SUPABASE_SERVICE_KEY");

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(", ")}`,
    );
  }
}
