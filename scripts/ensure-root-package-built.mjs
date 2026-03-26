import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(scriptsDir, "..");
const marker = join(repoRoot, "dist", "main", "index.js");
// Existence-only check: if dist/main/index.js exists we assume the root package is
// built. We do NOT check freshness — if you have edited root source, run
// `pnpm build` from the repo root before `pnpm run dev` here.
if (existsSync(marker)) {
  process.exit(0);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(pnpm, ["build"], { cwd: repoRoot, stdio: "inherit" });
if (result.error) {
  process.stderr.write(
    `ensure-root-package-built: failed to spawn pnpm: ${result.error.message}\n`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
