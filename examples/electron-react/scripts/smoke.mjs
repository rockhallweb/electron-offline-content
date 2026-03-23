import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleRoot = dirname(__dirname);
const smokeRoot = join(exampleRoot, ".smoke");
const rendererOutDir = join(smokeRoot, "renderer");
const sentinelPath = process.env.MEDIA_CACHE_SMOKE_SENTINEL ?? join(smokeRoot, "result.json");
const profile = process.env.MEDIA_CACHE_EXAMPLE_PROFILE ?? "local";
const logFormat = process.env.MEDIA_CACHE_LOG_FORMAT ?? "json";
const logLevel = process.env.MEDIA_CACHE_LOG_LEVEL ?? "info";
const devPassthrough = false;
const runtimeConfigDir = join(exampleRoot, ".runtime");
const runtimeConfigPath = join(runtimeConfigDir, "example-config.json");

await mkdir(rendererOutDir, { recursive: true });
await mkdir(runtimeConfigDir, { recursive: true });
await writeFile(
  runtimeConfigPath,
  `${JSON.stringify({ profile, logFormat, logLevel, devPassthrough, assetBaseUrl: null }, null, 2)}\n`,
);

await run(
  "pnpm",
  [
    "exec",
    "vite",
    "build",
    "--config",
    "vite.renderer.config.ts",
    "--outDir",
    ".smoke/renderer",
    "--emptyOutDir",
  ],
  exampleRoot,
  process.env,
);

await build({
  absWorkingDir: exampleRoot,
  entryPoints: ["src/main.ts"],
  outfile: ".smoke/main.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["electron", "@rockhallweb/electron-offline-content/main"],
  define: {
    MAIN_WINDOW_VITE_DEV_SERVER_URL: "undefined",
    MAIN_WINDOW_VITE_NAME: JSON.stringify("main_window"),
  },
});

await build({
  absWorkingDir: exampleRoot,
  entryPoints: ["src/preload.ts"],
  outfile: ".smoke/preload.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
});

const electronArgs = [
  "exec",
  "electron",
  ".smoke/main.js",
  "--media-cache-smoke",
  `--media-cache-smoke-sentinel=${sentinelPath}`,
  `--media-cache-example-profile=${profile}`,
  `--media-cache-log-format=${logFormat}`,
  `--media-cache-log-level=${logLevel}`,
  `--media-cache-renderer-index=${join(rendererOutDir, "index.html")}`,
];

if (shouldDisableElectronSandbox()) {
  // GitHub-hosted Linux runners cannot use Electron's SUID sandbox from the temp install path.
  electronArgs.push("--no-sandbox");
}

await run("pnpm", electronArgs, exampleRoot, {
  ...process.env,
  MEDIA_CACHE_EXAMPLE_PROFILE: profile,
  MEDIA_CACHE_LOG_FORMAT: logFormat,
  MEDIA_CACHE_LOG_LEVEL: logLevel,
  MEDIA_CACHE_DEV_PASSTHROUGH: "false",
});

await waitForFile(sentinelPath, 30_000);
const payload = JSON.parse(await readFile(sentinelPath, "utf8"));
process.stdout.write(`MEDIA_CACHE_EXAMPLE_SMOKE_RESULT ${JSON.stringify(payload)}\n`);
process.exit(payload.ok ? 0 : 1);

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command,
      args,
      {
        cwd,
        env,
        stdio: "inherit",
      },
    );

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

async function waitForFile(path, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Timed out waiting for smoke sentinel at ${path}.`);
}

function shouldDisableElectronSandbox() {
  return process.platform === "linux" && process.env.GITHUB_ACTIONS === "true";
}
