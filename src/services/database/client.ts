import { Database } from "../../database.types";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let supabaseClient: SupabaseClient<Database> | null = null;

/**
 * Get or create Supabase client instance
 */
export function getSupabaseClient(): SupabaseClient<Database> {
  if (!supabaseClient) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        "Missing Supabase configuration. Please check SUPABASE_URL and SUPABASE_ANON_KEY environment variables.",
      );
    }

    supabaseClient = createClient<Database>(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: false, // We handle sessions manually
      },
      db: {
        schema: "public",
      },
      global: {
        headers: {
          "X-Client-Info": "crawler-backend",
        },
      },
    });
  }

  return supabaseClient;
}

/**
 * Get Supabase client with service role key (for admin operations)
 */
export function getSupabaseServiceClient(): SupabaseClient<Database> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "Missing Supabase service configuration. Please check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.",
    );
  }

  return createClient<Database>(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: "public",
    },
  });
}

/**
 * Test database connection
 */
export async function testDatabaseConnection(): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("profiles")
      .select("id")
      .limit(1);

    if (error) {
      console.error("Database connection test failed:", error);
      return false;
    }

    console.log("Database connection test successful");
    return true;
  } catch (error) {
    console.error("Database connection test failed:", error);
    return false;
  }
}

/**
 * Close database connections (for graceful shutdown)
 */
export function closeDatabaseConnections(): void {
  if (supabaseClient) {
    // Supabase client doesn't have an explicit close method
    // but we can nullify the reference
    supabaseClient = null;
    console.log("Database connections closed");
  }
}
