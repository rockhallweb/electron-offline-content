import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

/** Main-process and shared tests (used by `pnpm test` / `pnpm test:smoke` first phase). */
export default defineConfig({
  test: {
    include: ["tests/main/**/*.test.ts"],
    environment: "node",
    ...(ci ? { maxWorkers: 1, fileParallelism: false } : {}),
  },
});
