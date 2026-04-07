import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** Renderer hook tests; separate process avoids Vitest multi-project stalls on CI. */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/react/**/*.test.tsx"],
    environment: "happy-dom",
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
