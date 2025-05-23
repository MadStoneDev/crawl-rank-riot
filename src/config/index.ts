import dotenv from "dotenv";

// Load environment variables
dotenv.config();

export interface Config {
  server: {
    port: number;
    environment: string;
    allowedOrigins: string[];
  };
  database: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    supabaseServiceKey?: string;
  };
  crawler: {
    userAgent: string;
    maxDepth: number;
    maxPages: number;
    concurrentRequests: number;
    defaultTimeout: number;
    perDomainDelay: number;
    defaultDelay: number;
  };
  scheduler: {
    enabled: boolean;
    checkInterval: number; // in milliseconds
  };
}

export const config: Config = {
  server: {
    port: parseInt(process.env.PORT || "3001", 10),
    environment: process.env.NODE_ENV || "development",
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
      : ["http://localhost:3000", "https://your-frontend-domain.com"],
  },
  database: {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  crawler: {
    userAgent: process.env.CRAWLER_USER_AGENT || "RankRiot/1.0 SEO Crawler",
    maxDepth: parseInt(process.env.CRAWLER_MAX_DEPTH || "3", 10),
    maxPages: parseInt(process.env.CRAWLER_MAX_PAGES || "100", 10),
    concurrentRequests: parseInt(
      process.env.CRAWLER_CONCURRENT_REQUESTS || "3",
      10,
    ),
    defaultTimeout: parseInt(process.env.CRAWLER_TIMEOUT || "30000", 10),
    perDomainDelay: parseInt(
      process.env.CRAWLER_PER_DOMAIN_DELAY || "1000",
      10,
    ),
    defaultDelay: parseInt(process.env.CRAWLER_DEFAULT_DELAY || "500", 10),
  },
  scheduler: {
    enabled: process.env.SCHEDULER_ENABLED !== "false",
    checkInterval: parseInt(
      process.env.SCHEDULER_CHECK_INTERVAL || "3600000",
      10,
    ), // 1 hour
  },
};

/**
 * Validate configuration
 */
export function validateConfig(): void {
  const errors: string[] = [];

  // Server validation
  if (config.server.port < 1 || config.server.port > 65535) {
    errors.push("Invalid server port");
  }

  // Database validation
  if (!config.database.supabaseUrl) {
    errors.push("SUPABASE_URL is required");
  }

  if (!config.database.supabaseAnonKey) {
    errors.push("SUPABASE_ANON_KEY is required");
  }

  // URL validation
  try {
    new URL(config.database.supabaseUrl);
  } catch {
    errors.push("SUPABASE_URL must be a valid URL");
  }

  // Crawler validation
  if (config.crawler.maxDepth < 1 || config.crawler.maxDepth > 10) {
    errors.push("Crawler max depth must be between 1 and 10");
  }

  if (config.crawler.maxPages < 1 || config.crawler.maxPages > 10000) {
    errors.push("Crawler max pages must be between 1 and 10000");
  }

  if (
    config.crawler.concurrentRequests < 1 ||
    config.crawler.concurrentRequests > 10
  ) {
    errors.push("Crawler concurrent requests must be between 1 and 10");
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join("\n")}`);
  }
}

/**
 * Get environment-specific configuration
 */
export function getEnvironmentConfig() {
  return {
    isDevelopment: config.server.environment === "development",
    isProduction: config.server.environment === "production",
    isTest: config.server.environment === "test",
  };
}

/**
 * Print configuration (safe for logging)
 */
export function printConfig(): void {
  console.log("Configuration loaded:");
  console.log("- Server port:", config.server.port);
  console.log("- Environment:", config.server.environment);
  console.log("- Allowed origins:", config.server.allowedOrigins.join(", "));
  console.log("- Supabase URL:", config.database.supabaseUrl);
  console.log("- Crawler max depth:", config.crawler.maxDepth);
  console.log("- Crawler max pages:", config.crawler.maxPages);
  console.log(
    "- Crawler concurrent requests:",
    config.crawler.concurrentRequests,
  );
  console.log("- Scheduler enabled:", config.scheduler.enabled);
}
