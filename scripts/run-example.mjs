import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const target = process.argv[2];
if (target !== "local" && target !== "nasa") {
  process.stderr.write("Usage: node scripts/run-example.mjs <local|nasa>\n");
  process.exit(1);
}

const exampleDir = join(repoRoot, "examples", target);

ensureExampleDeps(exampleDir);

const child = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["exec", "electron-forge", "start"],
  {
    cwd: exampleDir,
    stdio: "inherit",
    env: process.env,
  },
);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

function ensureExampleDeps(cwd) {
  const result = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["install", "--frozen-lockfile"],
    {
      cwd,
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
