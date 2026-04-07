import { defineConfig } from "vitest/config";

/** Renderer hook tests; separate process avoids Vitest multi-project stalls on CI. */
export default defineConfig({
  test: {
    include: ["tests/react/**/*.test.tsx"],
    environment: "happy-dom",
  },
});
