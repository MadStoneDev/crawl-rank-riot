// Safety gate for the e2e suite.
//
// These tests write to and delete from a real database. They must ONLY ever run
// against a local Supabase (supabase start). This refuses to run the moment the
// configured SUPABASE_URL is anything other than localhost/127.0.0.1, so a stray
// production .env can never point the suite at real data.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function isLocalSupabaseUrl(raw: string | undefined | null): boolean {
  if (!raw) return false;
  try {
    const { hostname } = new URL(raw);
    return LOCAL_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * Throw unless SUPABASE_URL is a local Supabase. Returns the validated URL and
 * service-role key for the caller. Called by the e2e globalSetup AND by every
 * client factory, so there is no path to a non-local DB.
 */
export function assertLocalSupabase(): { url: string; serviceKey: string } {
  const url = process.env.SUPABASE_URL;
  if (!isLocalSupabaseUrl(url)) {
    throw new Error(
      [
        "Refusing to run the e2e suite: SUPABASE_URL must point at a LOCAL Supabase",
        `(localhost / 127.0.0.1). Got: ${url ?? "<unset>"}.`,
        "",
        "Run `supabase start`, apply the migrations locally, then export its local",
        "SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY before",
        "`npm run test:e2e`. Never run these tests against production.",
      ].join("\n"),
    );
  }
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
  if (!serviceKey) {
    throw new Error(
      "Refusing to run the e2e suite: SUPABASE_SERVICE_ROLE_KEY is not set (needed to seed the local DB).",
    );
  }
  return { url: url as string, serviceKey };
}
