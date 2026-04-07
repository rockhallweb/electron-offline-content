import { defineConfig } from "vitest/config";

/**
 * Renderer hook tests. Uses esbuild JSX (no `@vitejs/plugin-react`).
 * The former single large `media-cache-react` file was split so Vite collect/transform stays reliable on CI.
 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  server: {
    deps: {
      inline: ["react", "react-dom", "@testing-library/react"],
    },
  },
  test: {
    include: ["tests/react/**/*.test.tsx"],
    environment: "happy-dom",
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
