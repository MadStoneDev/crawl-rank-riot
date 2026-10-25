import { defineConfig } from "vitest/config";

// The opt-in end-to-end suite. It talks to a REAL Supabase over HTTP, so it is
// deliberately separate from the default unit run and gated to localhost only:
// globalSetup refuses to run unless SUPABASE_URL points at a local Supabase
// (see test/e2e/helpers/global-setup.ts). Run with `npm run test:e2e` after
// `supabase start` and applying the migrations locally.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    globalSetup: ["test/e2e/helpers/global-setup.ts"],
    environment: "node",
    // A real crawl + DB round-trips need longer than the unit defaults.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Shared in-memory rate-limit state + one-scan-per-project guards make
    // parallel files race; run them serially.
    fileParallelism: false,
  },
});
