# Contributing

Development guide for `@rockhallweb/electron-offline-content`.

## Repository layout

- **Root package** -- `@rockhallweb/electron-offline-content` (library source and published `dist/` output).
- **`pnpm-workspace.yaml`** -- declares only the root package (`packages: ["."]`) so the root `pnpm-lock.yaml` stays limited to the library. Without this, pnpm can treat nested `package.json` files as extra importers and merge example dependencies into the root lockfile.
- **Example apps** -- `examples/local` and `examples/nasa` are standalone pnpm projects (each has its own `pnpm-lock.yaml`). They depend on the root package via a local path (`../../`). A root `pnpm install` installs only the library; install example dependencies separately (see commands below).

Each example is a small Electron Forge + React + Vite app that shows how to wire the library end-to-end. The linked package resolves to compiled files under `dist/`; if you run `pnpm dev` from an example directory, `predev` builds the root package when `dist/` is missing.

## Commands

### Library

| Command             | Description                                     |
| ------------------- | ----------------------------------------------- |
| `pnpm lint`         | Run Oxlint across the repository.               |
| `pnpm format:check` | Verify formatting with Oxfmt without rewriting. |
| `pnpm format`       | Rewrite supported files in place with Oxfmt.    |
| `pnpm check`        | Type-check the package.                         |
| `pnpm test`         | Run package-level behavior tests.               |
| `pnpm build`        | Build package outputs in `dist/`.               |

### Examples

| Command                      | Description                                              |
| ---------------------------- | -------------------------------------------------------- |
| `pnpm install:example:local` | Install dependencies for `examples/local`.               |
| `pnpm install:example:nasa`  | Install dependencies for `examples/nasa`.                |
| `pnpm example:local:dev`     | Build the library and launch the local-fixtures example. |
| `pnpm example:nasa:dev`      | Build the library and launch the NASA example.           |

### Validation

| Command            | Description                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm pack:verify` | Pack the library into a tarball, install it into a temporary copy of `examples/local`, and run `tsc --noEmit` to catch publish/resolution issues. |
| `pnpm ci:validate` | Full validation chain: lint, format check, type-check, test, build, and `pack:verify`.                                                            |

## CI

GitHub Actions uses the same `pnpm ci:validate` entrypoint. The workflow is restricted to member-controlled branches and same-repository PRs. See [`docs/ci.md`](docs/ci.md) for the repository-side policy and required GitHub settings.

## Day-to-day workflow

Development uses a path-linked example plus root `pnpm build`. Run `pnpm pack:verify` to exercise the same install path consumers get from the registry tarball (using `examples/local`). This catches export or packaging mistakes that path linking can hide.
