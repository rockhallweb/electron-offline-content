import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

export default defineConfig({
  test: {
    // On CI, default parallelism can exhaust the default ~2GB worker heap (node + jsdom projects).
    ...(ci ? { maxWorkers: 1, fileParallelism: false } : {}),
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/main/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "jsdom",
          include: ["tests/react/**/*.test.tsx"],
          environment: "jsdom",
        },
      },
    ],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
