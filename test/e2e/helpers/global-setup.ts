import { assertLocalSupabase } from "./guard";

// Runs once before any e2e test file. Aborts the entire run (with a clear
// message) unless SUPABASE_URL is a local Supabase, so the suite can never touch
// production data.
export default function setup(): void {
  const { url } = assertLocalSupabase();
  // eslint-disable-next-line no-console
  console.log(`[e2e] using local Supabase at ${url}`);
}
