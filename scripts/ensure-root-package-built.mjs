import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(scriptsDir, "..");
const marker = join(repoRoot, "dist", "main", "index.js");
if (existsSync(marker)) {
  process.exit(0);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(pnpm, ["build"], { cwd: repoRoot, stdio: "inherit" });
process.exit(result.status ?? 1);
