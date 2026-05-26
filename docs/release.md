# Release

This package is staged for npm publishing from GitHub Actions with npm Trusted Publishing. Do not publish from a local laptop for routine releases.

## One-time setup

Configure npm before the first CI release:

1. Open the npm package settings for [`@rockhall/electron-offline-content`](https://www.npmjs.com/package/@rockhall/electron-offline-content).
2. Add a trusted publisher for the GitHub repository `rockhallweb/electron-offline-content`.
3. Use workflow file `.github/workflows/release.yml`.
4. Use environment `npm`.
5. Under allowed actions, select `Allow npm stage publish`. Do not select `Allow npm publish`.
6. In GitHub, create an environment named `npm`. Require reviewer approval if you want a manual approval gate before staging.

Trusted Publishing uses GitHub's OIDC identity for the configured workflow, so this repository does not need an `NPM_TOKEN` secret. Staged publishing keeps CI from publishing directly: the workflow can only stage the package, and a maintainer must approve the staged package with 2FA before it becomes public.

## Release process

1. Update `package.json` to the new version and update `CHANGELOG.md`.
2. Open and merge a PR with that version bump.
3. Wait for the `CI` workflow on `main` to pass.
4. Create a GitHub Release from the matching tag, for example `v0.4.1`.
5. Publish the GitHub Release.

Publishing the GitHub Release starts the `Release` workflow. The workflow checks that the release tag matches `package.json`, runs the full package test suite, runs `pnpm validate`, verifies the packed tarball, verifies the example apps, and then runs `npm stage publish --access public`.

After the release workflow succeeds, approve the staged package:

```bash
npm stage list @rockhall/electron-offline-content
npm stage view <stage-id>
npm stage download <stage-id>
npm stage approve <stage-id>
```

Use `npm stage reject <stage-id>` instead if inspection finds a problem.

## Recovery

If the release workflow fails before the stage step, fix the issue in a new PR, merge it, delete the failed tag or create a new patch version, and publish a new GitHub Release.

If staging succeeds but approval finds a problem, reject the staged package and create a new patch release.
