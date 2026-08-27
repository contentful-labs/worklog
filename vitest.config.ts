import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/__tests__/**/*.test.ts", "lib/sdk/__tests__/**/*.test.ts", "commands/__tests__/**/*.test.ts"],
    // Redirects the config and cache directories to a temp tree before any module reads
    // them, so a test that forgets cannot reach the developer's own. See test/home.ts.
    setupFiles: ["test/setup.ts"],
  },
});
