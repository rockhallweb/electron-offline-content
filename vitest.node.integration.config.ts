import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

/** Main-process integration tests for the dedicated CI integration lane. */
export default defineConfig({
  test: {
    include: ["tests/main/**/*.integration.test.ts"],
    environment: "node",
    ...(ci ? { maxWorkers: 1, fileParallelism: false } : {}),
  },
});
