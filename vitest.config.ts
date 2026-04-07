import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

export default defineConfig({
  test: {
    // On CI, cap workers to stay within ubuntu-latest RAM while overlapping node + jsdom projects.
    ...(ci ? { maxWorkers: 2 } : {}),
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
