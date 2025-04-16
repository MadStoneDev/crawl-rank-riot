import { createClient } from "@supabase/supabase-js";
import { Database } from "../database.types";

import config from "../config";
import logger from "../utils/logger";

// Create a single supabase client for the entire app
const supabase = createClient<Database>(
  config.supabase.url,
  config.supabase.serviceKey,
  {
    auth: {
      persistSession: false,
    },
  },
);

// Test the connection
async function testConnection(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("projects")
      .select("id")
      .limit(1);
    if (error) throw error;
    logger.info("Connected to Supabase successfully");
  } catch (error) {
    logger.error("Failed to connect to Supabase:", error);
    process.exit(1);
  }
}

export { supabase, testConnection };
