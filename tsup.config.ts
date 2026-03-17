import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      "main/index": "src/main/index.ts",
      "main/database": "src/main/database.ts",
      "main/default-storage": "src/main/default-storage.ts",
      "main/media-cache": "src/main/media-cache.ts",
      "preload/index": "src/preload/index.ts",
      "shared/errors": "src/shared/errors.ts",
      "shared/ipc": "src/shared/ipc.ts",
      "shared/normalize": "src/shared/normalize.ts",
      "shared/pagination": "src/shared/pagination.ts",
      "shared/stem": "src/shared/stem.ts",
      "shared/types": "src/shared/types.ts",
      "shared/validation": "src/shared/validation.ts",
    },
    clean: true,
    dts: true,
    format: ["esm", "cjs"],
    sourcemap: true,
    target: "es2022",
    bundle: false,
    splitting: false,
    treeshake: true,
    platform: "node",
    outExtension({ format }) {
      return {
        js: format === "esm" ? ".js" : ".cjs",
      };
    },
  },
  {
    entry: {
      "react/index": "src/react/index.tsx",
    },
    clean: false,
    dts: true,
    format: ["esm", "cjs"],
    sourcemap: true,
    target: "es2022",
    bundle: false,
    splitting: false,
    treeshake: true,
    platform: "browser",
    outExtension({ format }) {
      return {
        js: format === "esm" ? ".js" : ".cjs",
      };
    },
  },
]);
