import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

/**
 * Default config for `vitest` / `vitest watch` (multi-project).
 * CI and `pnpm test` / `pnpm test:smoke` use focused Vitest configs sequentially instead.
 */
export default defineConfig({
  test: {
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
          name: "renderer",
          include: ["tests/renderer/**/*.test.ts"],
          environment: "happy-dom",
        },
      },
    ],
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text", "html"],
    },
  },
});
