import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

export default defineConfig({
  test: {
    // On CI, a single worker avoids stalls seen with maxWorkers>1 (tinypool + node/jsdom projects).
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
