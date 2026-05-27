# CI

This repository uses two GitHub Actions workflows:

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the Turbo-backed root validation pipeline plus explicit example setup.
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) stages GitHub Releases on npm through npm Trusted Publishing.

The CI workflow runs:

```bash
pnpm validate
pnpm install --frozen-lockfile --ignore-scripts --dir examples/local
pnpm install --frozen-lockfile --ignore-scripts --dir examples/nasa
pnpm examples:verify
```

`pnpm validate` runs the root package graph from [`turbo.json`](../turbo.json): lint, format check, type-check, `test:smoke` (main-process Vitest without integration tests, via [`vitest.node.smoke.config.ts`](../vitest.node.smoke.config.ts)), **`pnpm test:react`** (renderer hook tests via [`vitest.react.config.ts`](../vitest.react.config.ts)), and build. On pushes to `main`, CI also runs `pnpm pack:verify` after validate. On `main` / `workflow_dispatch` / merge queue, the **test integration** job runs only `tests/main/**/*.integration.test.ts` via [`vitest.node.integration.config.ts`](../vitest.node.integration.config.ts). `pack:verify` packs the library, installs that tarball into a temporary copy of `examples/local`, and runs `tsc --noEmit -p tsconfig.pack-verify.json` there (main/preload/example manifest wiring only).

`pnpm examples:verify` runs each example’s `validate` script (lint, format check, knip) in `examples/local` and `examples/nasa` in parallel via [`scripts/run-examples.mjs`](../scripts/run-examples.mjs). CI installs example dependencies with `--ignore-scripts` (skips Electron postinstall) because verification does not need the binary. This repository is still not a monorepo workspace.

The workflow is intentionally member-oriented:

- `push` runs only on `main`
- `pull_request` jobs run only when the PR head branch lives in this repository
- `workflow_dispatch` is available only to users with write access
- `merge_group` is supported for merge queue validation

That means public fork PRs may still create a skipped workflow record, but the validation job itself does not run.

## Required GitHub Settings

The repository YAML cannot enforce all of the access policy. Configure these in the GitHub UI:

1. Protect `main` and require the `CI / validate` status check before merge. If you rely on the integration job for merge queue or release hygiene, also require **CI / test integration**.
2. Keep branch creation and push access limited to `rockhallweb` members.
3. In Actions settings, allow only GitHub-authored or explicitly approved actions.

Do not add `pull_request_target`, secrets, or write-scoped workflow permissions for this CI path.

## Release Publishing

The release workflow runs when a non-prerelease GitHub Release is published. It checks out the release tag, requires the tag to match `package.json`, runs the full test and validation matrix, verifies the packed tarball, verifies both example apps, uploads the package tarball as an artifact, and stages that artifact on npm. A maintainer must approve the staged package with 2FA before it becomes public.

The release workflow uses `id-token: write` only on the job that calls npm Trusted Publishing. It does not use an `NPM_TOKEN` secret and should only be allowed to run `npm stage publish`, not `npm publish`. See [`docs/release.md`](release.md) for the release process and npm setup.
