import { defineConfig } from "vitest/config";

// Pinned so a local-time bug cannot hide on a machine that runs in Europe/Paris.
process.env.TZ = "America/New_York";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
