import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

/**
 * Default config for `vitest` / `vitest watch` (multi-project).
 * CI and `pnpm test` / `pnpm test:smoke` use `vitest.node.config.ts` + `vitest.react.config.ts` sequentially instead.
 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
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
          name: "react",
          include: ["tests/react/**/*.test.tsx"],
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
