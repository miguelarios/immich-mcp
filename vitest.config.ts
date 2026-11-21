import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/__tests__/**/*.test.ts"],
    // Clears the developer's own Immich configuration from the environment.
    setupFiles: ["./vitest.setup.ts"],
  },
});
