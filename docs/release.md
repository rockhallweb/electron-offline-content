# Release

This package is published to npm from GitHub Actions with npm Trusted Publishing. Do not publish from a local laptop for routine releases.

## One-time setup

Configure npm before the first CI release:

1. Open the npm package settings for [`@rockhall/electron-offline-content`](https://www.npmjs.com/package/@rockhall/electron-offline-content).
2. Add a trusted publisher for the GitHub repository `rockhallweb/electron-offline-content`.
3. Use workflow file `.github/workflows/release.yml`.
4. Use environment `npm`.
5. In GitHub, create an environment named `npm`. Require reviewer approval if you want a manual approval gate before publish.

Trusted Publishing uses GitHub's OIDC identity for the configured workflow, so this repository does not need an `NPM_TOKEN` secret.

## Release process

1. Update `package.json` to the new version and update `CHANGELOG.md`.
2. Open and merge a PR with that version bump.
3. Wait for the `CI` workflow on `main` to pass.
4. Create a GitHub Release from the matching tag, for example `v0.4.1`.
5. Publish the GitHub Release.

Publishing the GitHub Release starts the `Release` workflow. The workflow checks that the release tag matches `package.json`, runs the full package test suite, runs `pnpm validate`, verifies the packed tarball, verifies the example apps, and then runs `npm publish --access public`.

## Recovery

If the release workflow fails before the publish step, fix the issue in a new PR, merge it, delete the failed tag or create a new patch version, and publish a new GitHub Release.

If npm publish succeeds but a later step ever fails, do not republish the same version. npm versions are immutable. Create a new patch release instead.
