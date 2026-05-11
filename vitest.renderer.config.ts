import { defineConfig } from "vitest/config";

/** Framework-agnostic renderer tests (no JSX). */
export default defineConfig({
  test: {
    include: ["tests/renderer/**/*.test.ts"],
    environment: "happy-dom",
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
