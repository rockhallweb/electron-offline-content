# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is an npm library (`@rockhallweb/electron-offline-content`) for Electron apps that need to download, index, and serve offline media content. It is **not** a standalone app—"running it" means building the library and launching one of the bundled example Electron apps.

### Prerequisites

- **Node.js >= 24** (required for built-in `node:sqlite`). Install via `nvm install 24 && nvm alias default 24`.
- **pnpm 10.30.2** (pinned via `packageManager` field). Activate via `corepack enable && corepack prepare pnpm@10.30.2 --activate`.
- **xvfb** for headless Electron (already installed on the VM). Prefix Electron commands with `xvfb-run -a`.

### Key commands

All commands are documented in `CONTRIBUTING.md`. Quick reference:

| Task                  | Command                              |
| --------------------- | ------------------------------------ |
| Install deps          | `pnpm install`                       |
| Lint                  | `pnpm lint`                          |
| Format check          | `pnpm format:check`                  |
| Type check            | `pnpm check`                         |
| Test                  | `pnpm test`                          |
| Build                 | `pnpm build`                         |
| Full validation       | `pnpm validate`                      |
| Install local example | `pnpm install:example:local`         |
| Run local example     | `xvfb-run -a pnpm example:local:dev` |

### Before pushing

Always run `pnpm format` before committing — `oxfmt` enforces markdown table alignment and other formatting rules that are easy to miss when hand-editing. CI runs `pnpm validate` which includes `pnpm lint`, `pnpm format:check`, `pnpm check` (TypeScript), `pnpm test`, and `pnpm build`. A minimal pre-push sanity check:

```bash
pnpm format
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm build
```

Or run everything in one shot: `pnpm validate`.

### Non-obvious caveats

- The example apps (`examples/local`, `examples/nasa`) are **standalone pnpm projects** with their own lockfiles. They are NOT part of the root pnpm workspace. Install their deps separately via `pnpm install:example:local` or `pnpm install:example:nasa`.
- Examples link to `../../` (the root library build output in `dist/`). The `predev` script in each example runs `ensure-root-package-built.mjs` which builds the library if `dist/` is missing, but if you've made library source changes you must run `pnpm build` first.
- `node:sqlite` is experimental in Node 24—expect `ExperimentalWarning` messages in test and app output. These are harmless.
- D-Bus errors in xvfb-run output (`Failed to connect to the bus`) are expected in a headless environment and do not affect functionality.
- Turbo (`turbo.json`) orchestrates root tasks but this is **not** a monorepo workspace. Turbo only manages the root package graph.
