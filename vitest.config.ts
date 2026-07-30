import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Co-located *.test.ts next to source, plus anything under test/.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
