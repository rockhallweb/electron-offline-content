import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const exampleDir = join(repoRoot, "examples", "electron-react");

const mode = process.argv[2] ?? "dev";
const isSmoke = mode === "smoke";
const smokeDir = isSmoke ? await mkdtemp(join(tmpdir(), "media-cache-example-smoke-")) : null;
const smokeSentinel = smokeDir ? join(smokeDir, "result.json") : null;
const smokeStorageRoot = smokeDir ? join(smokeDir, "cache") : null;
const profile = process.env.MEDIA_CACHE_EXAMPLE_PROFILE ?? "local";
const logFormat = process.env.MEDIA_CACHE_LOG_FORMAT ?? (isSmoke ? "json" : "pretty");
const logLevel = process.env.MEDIA_CACHE_LOG_LEVEL ?? "info";
const devPassthrough = isSmoke ? false : undefined;
const runtimeConfigDir = join(exampleDir, ".runtime");
const runtimeConfigPath = join(runtimeConfigDir, "example-config.json");
await mkdir(runtimeConfigDir, { recursive: true });
await writeFile(
  runtimeConfigPath,
  `${JSON.stringify({ profile, logFormat, logLevel, devPassthrough }, null, 2)}\n`,
);
const args = isSmoke
  ? ["run", "smoke"]
  : [
      "exec",
      "electron-forge",
      "start",
      "--",
      `--media-cache-example-profile=${profile}`,
      `--media-cache-log-format=${logFormat}`,
      `--media-cache-log-level=${logLevel}`,
    ];
const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
  cwd: exampleDir,
  stdio: "inherit",
  env: {
    ...process.env,
    MEDIA_CACHE_EXAMPLE_PROFILE: profile,
    MEDIA_CACHE_LOG_FORMAT: logFormat,
    MEDIA_CACHE_LOG_LEVEL: logLevel,
    MEDIA_CACHE_SMOKE_SENTINEL: smokeSentinel ?? "",
    ...resolveOptionalEnv(
      "MEDIA_CACHE_DEV_PASSTHROUGH",
      devPassthrough === undefined ? process.env.MEDIA_CACHE_DEV_PASSTHROUGH : "false",
    ),
    ...resolveOptionalEnv(
      "MEDIA_CACHE_STORAGE_ROOT",
      smokeStorageRoot ?? process.env.MEDIA_CACHE_STORAGE_ROOT,
    ),
  },
});

child.on("exit", async (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (isSmoke) {
    try {
      await waitForFile(smokeSentinel, 30_000);
      const payload = JSON.parse(await readFile(smokeSentinel, "utf8"));
      process.stdout.write(`MEDIA_CACHE_SMOKE_RESULT ${JSON.stringify(payload)}\n`);
      await rm(smokeDir, { recursive: true, force: true });
      process.exit(code === 0 && payload.ok ? 0 : 1);
      return;
    } catch (error) {
      process.stderr.write(`Missing smoke sentinel: ${String(error)}\n`);
      await rm(smokeDir, { recursive: true, force: true });
      process.exit(1);
      return;
    }
  }
  process.exit(code ?? 1);
});

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
}

function resolveOptionalEnv(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }

  return { [name]: value };
}
