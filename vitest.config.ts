import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Co-located *.test.ts next to source, plus anything under test/.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The e2e suite needs a running LOCAL Supabase and is opt-in via `test:e2e`
    // (vitest.e2e.config.ts). Keep it out of the default unit run.
    exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
    environment: "node",
  },
});
