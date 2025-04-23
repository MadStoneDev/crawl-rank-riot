import dotenv from "dotenv";
dotenv.config();

interface DatabaseConfig {
  supabaseUrl: string;
  supabaseKey: string;
}

interface Config {
  database: DatabaseConfig;
  redis: {
    enabled: boolean;
    url: string;
    token: string;
  };
  crawler: {
    userAgent: string;

    maxDepth: number;
    maxPages: number;
    defaultTimeout: number;
    concurrentRequests: number;

    defaultDelay: number;
    perDomainDelay: number;
  };

  server: {
    port: number;
    allowedOrigins: string[];
  };
}

export const config: Config = {
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

    defaultDelay: 100,
    perDomainDelay: 200,
  },
  server: {
    port: parseInt(process.env.PORT || "3000", 10),
    allowedOrigins: ["https://rankriot.app", "http://localhost:3123"],
  },
};

export function validateConfig(): void {
  const missingVars = [];

  if (!config.database.supabaseUrl) missingVars.push("SUPABASE_URL");
  if (!config.database.supabaseKey) missingVars.push("SUPABASE_SERVICE_KEY");

  if (config.redis.enabled) {
    if (!config.redis.url) missingVars.push("UPSTASH_REDIS_REST_URL");
    if (!config.redis.token) missingVars.push("UPSTASH_REDIS_REST_TOKEN");
  }

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(", ")}`,
    );
  }
}
