# Contributing

Development guide for `@rockhallweb/electron-offline-content`.

## Repository layout

- **Root package** -- `@rockhallweb/electron-offline-content` (library source and published `dist/` output).
- **`turbo.json`** -- orchestrates the root build/test/lint pipelines and caches task outputs without turning the repository into a monorepo.
- **`pnpm-workspace.yaml`** -- declares only the root package (`packages: ["."]`) so the root `pnpm-lock.yaml` stays limited to the library. Without this, pnpm can treat nested `package.json` files as extra importers and merge example dependencies into the root lockfile.
- **Example apps** -- `examples/local` and `examples/nasa` are standalone pnpm projects (each has its own `pnpm-lock.yaml`). They depend on the root package via a local path (`../../`). A root `pnpm install` installs only the library; install example dependencies separately (see commands below).

Each example is a small Electron Forge + React + Vite app that shows how to wire the library end-to-end. The linked package resolves to compiled files under `dist/`; if you run `pnpm dev` from an example directory, `predev` builds the root package when `dist/` is missing.

## Commands

### Library

| Command             | Description                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm lint`         | Run Oxlint across the repository.                                                                |
| `pnpm format:check` | Verify formatting with Oxfmt without rewriting.                                                  |
| `pnpm format`       | Rewrite supported files in place with Oxfmt.                                                     |
| `pnpm check`        | Type-check the package.                                                                          |
| `pnpm test`         | Run package-level behavior tests.                                                                |
| `pnpm build`        | Build package outputs in `dist/`.                                                                |
| `pnpm validate`     | Run the Turbo validation graph for lint, format, type-check, test, build, and pack verification. |

### Examples

| Command                         | Description                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm install:example:local`    | Install dependencies for `examples/local` for local development or lockfile updates.              |
| `pnpm install:example:nasa`     | Install dependencies for `examples/nasa` for local development or lockfile updates.               |
| `pnpm install:example:local:ci` | Install `examples/local` with `--frozen-lockfile` for CI-style verification.                      |
| `pnpm install:example:nasa:ci`  | Install `examples/nasa` with `--frozen-lockfile` for CI-style verification.                       |
| `pnpm example:local:dev`        | Build the library and launch the local-fixtures example.                                          |
| `pnpm example:nasa:dev`         | Build the library and launch the NASA example.                                                    |
| `pnpm examples:verify`          | Run the Turbo verification graph for example lint, format, and knip checks only.                  |
| `pnpm examples:validate`        | Build the root package first, then run per-example verification groups against that latest build. |

### Validation

| Command            | Description                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm pack:verify` | Pack the library into a tarball, install it into a temporary copy of `examples/local`, and run `tsc --noEmit` to catch publish/resolution issues. |
| `pnpm ci:validate` | Compatibility alias for `pnpm validate`.                                                                                                          |
| `pnpm ci:examples` | Compatibility alias that performs CI-style example installs, then runs `pnpm examples:verify`.                                                    |

## CI

GitHub Actions uses `pnpm validate` for the root package graph, then runs explicit frozen-lockfile installs for the standalone examples before `pnpm examples:verify`. The workflow is restricted to member-controlled branches and same-repository PRs. See [`docs/ci.md`](docs/ci.md) for the repository-side policy and required GitHub settings.

## Day-to-day workflow

Development uses a path-linked example plus root `pnpm build`. Run `pnpm pack:verify` to exercise the same install path consumers get from the registry tarball (using `examples/local`). This catches export or packaging mistakes that path linking can hide.

The repo remains intentionally package-first:

- Turbo orchestrates tasks from the root package only.
- `examples/local` and `examples/nasa` are still standalone pnpm projects.
- Example installs are explicit setup steps; `pnpm examples:verify` only runs verification tasks.
- `pnpm examples:validate` is the consumer-oriented entrypoint when you want example checks to depend on a fresh root build in the Turbo graph.
- No folder move or workspace expansion is required for the current setup.

## Cursor worktrees

For package work in Cursor, use the root worktree helpers instead of cloning the repo again:

- `pnpm worktree:new <branch>` creates a sibling worktree under `../electron-media-cache-worktrees/<normalized-branch>` and runs `pnpm install --frozen-lockfile` in that worktree.
- `pnpm worktree:new <branch> -- --open` does the same, then opens the worktree in Cursor via the `cursor` CLI.
- `pnpm worktree:new <branch> -- --from main` changes the start point for a new branch. If the branch already exists locally, the script reuses it. If it exists on `origin` only, the script creates a tracking branch.
- `pnpm worktree:open <branch>` reopens an existing worktree in Cursor.
- `pnpm worktree:list` shows active worktrees.
- `pnpm worktree:prune` removes stale worktree metadata after you delete or remove worktrees.

This setup is intentionally package-first:

- The helper installs only the root package dependencies.
- Example app dependencies are not installed automatically.
- Use the existing example commands only when you explicitly want to exercise `examples/local` or `examples/nasa`.

Typical flow:

```bash
pnpm worktree:new feat/cache-api -- --open
cd ../electron-media-cache-worktrees/feat-cache-api
pnpm test
pnpm build
```
