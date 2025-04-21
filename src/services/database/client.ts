import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "../../config";
import { AppError, ErrorCode } from "../../utils/error";
import { Database } from "../../types/database";

// Singleton instance
let supabaseInstance: SupabaseClient<Database> | null = null;

/**
 * Initializes the Supabase client
 * @returns Initialized Supabase client
 * @throws AppError if initialization fails
 */
export function initializeSupabase(): SupabaseClient<Database> {
  try {
    const { supabaseUrl, supabaseKey } = config.database;

    if (!supabaseUrl || !supabaseKey) {
      throw new AppError(
        "Missing required environment variables for Supabase connection",
        ErrorCode.DATABASE_CONNECTION_ERROR,
      );
    }

    return createClient<Database>(supabaseUrl, supabaseKey);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown error initializing Supabase";
    throw new AppError(
      `Failed to initialize Supabase client: ${message}`,
      ErrorCode.DATABASE_CONNECTION_ERROR,
    );
  }
}

/**
 * Gets the Supabase client instance, initializing it if needed
 * @returns Supabase client instance
 */
export function getSupabaseClient(): SupabaseClient<Database> {
  if (!supabaseInstance) {
    supabaseInstance = initializeSupabase();
  }
  return supabaseInstance;
}

/**
 * Checks if the database connection is available
 * @returns True if connection is available
 */
export async function testDatabaseConnection(): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from("projects").select("id").limit(1);
    return !error;
  } catch (error) {
    console.error("Database connection test failed:", error);
    return false;
  }
}

/**
 * Resets the database connection (useful for testing)
 */
export function resetDatabaseConnection(): void {
  supabaseInstance = null;
}
