import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

/** Main-process smoke and unit tests for `pnpm test:smoke` / `pnpm validate`. */
export default defineConfig({
  test: {
    include: ["tests/main/**/*.test.ts"],
    exclude: ["tests/main/**/*.integration.test.ts"],
    environment: "node",
    ...(ci ? { maxWorkers: 1, fileParallelism: false } : {}),
  },
});
