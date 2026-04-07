import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

/** Full main-process and shared test suite (used by `pnpm test`). */
export default defineConfig({
  test: {
    include: ["tests/main/**/*.test.ts"],
    environment: "node",
    ...(ci ? { maxWorkers: 1, fileParallelism: false } : {}),
  },
});
