import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const scriptName = process.argv[2];
if (!scriptName) {
  process.stderr.write("Usage: node scripts/run-examples.mjs <pnpm-script-name>\n");
  process.exit(1);
}

const examples = ["local", "nasa"];
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runInExample(example) {
  return new Promise((resolve) => {
    const cwd = join(repoRoot, "examples", example);
    const child = spawn(pnpm, ["run", scriptName], {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve({ example, code: 1 });
        return;
      }
      resolve({ example, code: code ?? 1 });
    });
    child.on("error", (err) => {
      process.stderr.write(`run-examples: ${example}: ${err.message}\n`);
      resolve({ example, code: 1 });
    });
  });
}

const results = await Promise.all(examples.map(runInExample));
const failed = results.filter((r) => r.code !== 0);
if (failed.length > 0) {
  for (const r of failed) {
    process.stderr.write(`run-examples: examples/${r.example} exited with code ${r.code}\n`);
  }
  process.exit(1);
}
