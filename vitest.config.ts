import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/__tests__/**/*.test.ts", "commands/__tests__/**/*.test.ts"],
  },
});
