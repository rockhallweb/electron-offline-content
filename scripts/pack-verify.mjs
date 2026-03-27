import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const exampleDir = join(repoRoot, "examples", "local");

const workspaceTmp = await mkdtemp(join(tmpdir(), "media-cache-pack-verify-"));
const packDir = join(workspaceTmp, "pack");
const copiedExampleDir = join(workspaceTmp, "example");

try {
  await run("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: repoRoot,
    env: process.env,
  });

  const tarball = (await listDir(packDir)).find((file) => file.endsWith(".tgz"));
  if (!tarball) {
    throw new Error("pnpm pack did not produce a tarball.");
  }

  await cp(exampleDir, copiedExampleDir, {
    recursive: true,
    filter(source) {
      return (
        !source.includes("node_modules") && !source.includes(".vite") && !source.includes("out")
      );
    },
  });

  await writeFile(join(copiedExampleDir, ".npmrc"), "node-linker=hoisted\n");

  const packageJsonPath = join(copiedExampleDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.dependencies["@rockhallweb/electron-offline-content"] = join(packDir, tarball);
  packageJson.pnpm = {
    ...packageJson.pnpm,
    onlyBuiltDependencies: ["electron", "esbuild"],
  };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  await run("pnpm", ["install", "--no-frozen-lockfile", "--ignore-scripts=false"], {
    cwd: copiedExampleDir,
    env: process.env,
  });

  await run("pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.pack-verify.json"], {
    cwd: copiedExampleDir,
    env: process.env,
  });

  process.stdout.write(
    `MEDIA_CACHE_PACK_VERIFY_OK ${JSON.stringify({ tarball: join(packDir, tarball) })}\n`,
  );
} finally {
  await rm(workspaceTmp, { recursive: true, force: true });
}

async function listDir(path) {
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        stdio: "inherit",
      },
    );

    child.on("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(
          new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}.`),
        );
      }
    });
  });
}
