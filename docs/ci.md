# CI

This repository uses a single GitHub Actions workflow, [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), to run a Turbo-backed root validation pipeline plus explicit example setup:

```bash
pnpm validate
pnpm install:example:local:ci
pnpm install:example:nasa:ci
pnpm examples:verify
```

`pnpm validate` runs the root package graph from [`turbo.json`](../turbo.json): lint, format check, type-check, test, build, then `pack:verify`. `pack:verify` still packs the library, installs that tarball into a temporary copy of `examples/local`, and runs `tsc --noEmit -p tsconfig.pack-verify.json` there (main/preload/example manifest wiring only).

`pnpm examples:verify` keeps `examples/local` and `examples/nasa` as standalone pnpm projects while letting Turbo orchestrate only their lint, format, and knip checks from the root package. The example installs are explicit setup steps so the verification graph can cache independently. This repository is still not a monorepo workspace.

The workflow is intentionally member-oriented:

- `push` runs only on `main`
- `pull_request` jobs run only when the PR head branch lives in this repository
- `workflow_dispatch` is available only to users with write access
- `merge_group` is supported for merge queue validation

That means public fork PRs may still create a skipped workflow record, but the validation job itself does not run.

## Required GitHub Settings

The repository YAML cannot enforce all of the access policy. Configure these in the GitHub UI:

1. Protect `main` and require the `CI / validate` status check before merge.
2. Keep branch creation and push access limited to `rockhallweb` members.
3. In Actions settings, allow only GitHub-authored or explicitly approved actions.

Do not add `pull_request_target`, secrets, or write-scoped workflow permissions for this CI path.
