import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);
const repoName = basename(repoRoot);
const defaultBaseDir = join(dirname(repoRoot), `${repoName}-worktrees`);

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "create":
    createWorktree(args);
    break;
  case "open":
    openWorktree(args);
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    process.exit(command ? 0 : 1);
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n\n`);
    printUsage();
    process.exit(1);
}

function createWorktree(argv) {
  const options = parseArgs(argv, {
    boolean: new Set(["open", "no-install"]),
    string: new Set(["from", "base-dir", "path"]),
  });

  const branch = options.positionals[0];
  if (!branch) {
    process.stderr.write("Missing branch name.\n\n");
    printUsage();
    process.exit(1);
  }

  const startPoint = options.values.from ?? "main";
  const baseDir = resolve(options.values["base-dir"] ?? defaultBaseDir);
  const targetPath = resolve(options.values.path ?? join(baseDir, normalizeBranchName(branch)));

  if (existsSync(targetPath)) {
    fail(`Target path already exists: ${targetPath}`);
  }

  mkdirSync(dirname(targetPath), { recursive: true });

  if (hasRef(`refs/heads/${branch}`)) {
    run("git", ["worktree", "add", targetPath, branch], { cwd: repoRoot });
  } else if (hasRef(`refs/remotes/origin/${branch}`)) {
    run("git", ["worktree", "add", "--track", "-b", branch, targetPath, `origin/${branch}`], {
      cwd: repoRoot,
    });
  } else {
    run("git", ["worktree", "add", "-b", branch, targetPath, startPoint], { cwd: repoRoot });
  }

  if (!options.values["no-install"]) {
    run(pnpmCommand(), ["install", "--frozen-lockfile"], { cwd: targetPath });
  }

  if (options.values.open) {
    openInCursor(targetPath);
  }

  process.stdout.write(
    [
      `Created worktree for ${branch}`,
      `Path: ${targetPath}`,
      options.values["no-install"]
        ? "Dependencies were not installed."
        : "Installed root package dependencies only.",
      "Examples remain opt-in; install or run them separately if needed.",
    ].join("\n") + "\n",
  );
}

function openWorktree(argv) {
  const options = parseArgs(argv, {
    boolean: new Set(),
    string: new Set(["base-dir", "path"]),
  });

  const input = options.positionals[0];
  const baseDir = resolve(options.values["base-dir"] ?? defaultBaseDir);
  const targetPath = resolve(
    options.values.path ?? (input ? join(baseDir, normalizeBranchName(input)) : ""),
  );

  if (!input && !options.values.path) {
    process.stderr.write("Missing branch name or path.\n\n");
    printUsage();
    process.exit(1);
  }

  if (!existsSync(targetPath)) {
    fail(`Worktree path does not exist: ${targetPath}`);
  }

  openInCursor(targetPath);
  process.stdout.write(`Opened ${targetPath}\n`);
}

function openInCursor(targetPath) {
  const cursor = detectCursorCommand();
  if (!cursor) {
    fail(
      [
        "Cursor CLI was not found on PATH.",
        `Open this folder manually in Cursor: ${targetPath}`,
      ].join("\n"),
    );
  }

  run(cursor, [targetPath], { cwd: repoRoot });
}

function detectCursorCommand() {
  for (const candidate of ["cursor", "cursor.cmd"]) {
    const result = spawnSync(candidate, ["--version"], {
      cwd: repoRoot,
      stdio: "ignore",
      shell: false,
    });

    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  return null;
}

function hasRef(ref) {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return result.status === 0;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    fail(`Failed to run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseArgs(argv, schema) {
  const positionals = [];
  const values = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    if (schema.boolean.has(name)) {
      values[name] = true;
      continue;
    }

    if (!schema.string.has(name)) {
      fail(`Unknown option: --${name}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${name}`);
    }

    values[name] = value;
    index += 1;
  }

  return { positionals, values };
}

function normalizeBranchName(branch) {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function printUsage() {
  process.stdout.write(`Usage:
  pnpm worktree:new <branch> [-- --open] [-- --from <start-point>] [-- --base-dir <dir>]
  pnpm worktree:new <branch> -- --path <absolute-or-relative-path>
  pnpm worktree:open <branch>
  pnpm worktree:open -- --path <absolute-or-relative-path>

Defaults:
  Base directory: ${defaultBaseDir}
  Start point for new branches: main
  Dependency install: pnpm install --frozen-lockfile
`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
