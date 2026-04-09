import { defineConfig, type UserConfig } from "tsdown";

const nodeEntries = {
  "main/index": "src/main/index.ts",
  "main/store": "src/main/store.ts",
  "main/database": "src/main/database.ts",
  "main/media-cache": "src/main/media-cache.ts",
  "main/storage-root-lock": "src/main/storage-root-lock.ts",
  "preload/index": "src/preload/index.ts",
  "shared/errors": "src/shared/errors.ts",
  "shared/ipc": "src/shared/ipc.ts",
  "shared/normalize": "src/shared/normalize.ts",
  "shared/pagination": "src/shared/pagination.ts",
  "shared/stem": "src/shared/stem.ts",
  "shared/types": "src/shared/types.ts",
  "internal/asset-file-name": "src/internal/asset-file-name.ts",
  "internal/asset-key": "src/internal/asset-key.ts",
  "internal/log-format": "src/internal/log-format.ts",
  "internal/media-kind": "src/internal/media-kind.ts",
  "internal/url-warn": "src/internal/url-warn.ts",
  "internal/validation": "src/internal/validation.ts",
} as const;

function outExtensionJs(format: string) {
  const isEsm = format === "esm" || format === "module" || format === "es";
  return { js: isEsm ? ".js" : ".cjs" };
}

const sharedBuildOptions: Pick<
  UserConfig,
  "dts" | "format" | "sourcemap" | "target" | "unbundle" | "treeshake" | "hash" | "outExtensions"
> = {
  dts: true,
  format: ["esm", "cjs"],
  sourcemap: true,
  target: "es2022",
  unbundle: true,
  treeshake: true,
  hash: false,
  outExtensions({ format }: { format: string }) {
    return outExtensionJs(format);
  },
};

export default defineConfig([
  {
    entry: nodeEntries,
    clean: true,
    platform: "node",
    ...sharedBuildOptions,
  },
  {
    entry: {
      "react/index": "src/react/index.tsx",
    },
    clean: false,
    platform: "browser",
    ...sharedBuildOptions,
  },
]);
