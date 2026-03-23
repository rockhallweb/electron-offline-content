# `@rockhallweb/electron-offline-content`

A package for Electron apps to download, stage, and serve offline content from a remote source. Supports video, images, audio, text content, and more.

## Workspace

This repo is a pnpm workspace with:

- the package at the root
- a real consumer app at `examples/electron-react`

The example app is the maintainer validation target. It uses Electron Forge, React, and Vite for manual development, plus a direct Electron smoke path for deterministic automation.

## Features

- Global authoritative manifest sync with namespace support
- File-backed binary asset cache with SQLite metadata index
- Strict all-or-nothing snapshot commits
- Grace-period deletion for removed assets
- Privileged `media://` protocol for committed local assets
- Dev passthrough mode that returns direct remote asset URLs for local development
- Structured main-process log callback for forwarding cache events into `pino`, `logtape`, or a custom logger
- Preload bridge and React hooks for renderer access

## Install

```bash
pnpm add @rockhallweb/electron-offline-content
```

Peer dependencies:

- `electron >= 40`
- `react >= 18` when using `@rockhallweb/electron-offline-content/react`

## Development and Validation

Use the root commands for maintainership and CI:

- `pnpm lint`
  Run Oxlint across the workspace source and config files.
- `pnpm format:check`
  Verify formatting with Oxfmt without rewriting files.
- `pnpm format`
  Rewrite supported files in place with Oxfmt.
- `pnpm check`
  Type-check the package.
- `pnpm test`
  Run fast package-level behavior tests.
- `pnpm build`
  Build the package outputs in `dist/`.
- `pnpm example:dev`
  Launch the in-repo Electron Forge example for manual integration testing.
- `pnpm example:demo:nasa`
  Launch the manual demo against the NASA-backed profile with a minimal browsing interface.
- `pnpm example:smoke`
  Build and run the example in deterministic smoke mode against local fixtures.
- `pnpm pack:smoke`
  Pack the root package into a tarball, install that tarball into a temporary example copy, and run the same smoke assertions against the publishable artifact.
- `pnpm ci:validate`
  Run the full maintainer validation chain: lint, format check, type-check, test, build, and packed smoke.

GitHub Actions uses the same `pnpm ci:validate` entrypoint. The workflow is restricted to member-controlled branches and same-repository PRs; see [`docs/ci.md`](docs/ci.md) for the repository-side policy and required GitHub settings.

Workspace installs are for day-to-day development. `pnpm pack:smoke` is the release validation path because it catches package export mistakes, missing files, and install-time issues that workspace linking can hide.

## Example App

The example app lives at `examples/electron-react`.

Two content profiles are supported:

- `local`
  Default. Uses tiny local fixtures served over a local HTTP server. This is the profile used by smoke tests and CI.
- `nasa`
  Opt-in. Uses public NASA-hosted media for heavier manual demos. This is intentionally excluded from automated validation.

Examples:

```bash
pnpm example:dev
pnpm example:demo:nasa
MEDIA_CACHE_EXAMPLE_PROFILE=nasa pnpm example:dev
pnpm example:smoke
```

Example logging is configurable through the runtime config written by the launcher scripts. Manual runs default to pretty logs and smoke runs default to JSON logs.

Overrides:

```bash
MEDIA_CACHE_LOG_FORMAT=pretty MEDIA_CACHE_LOG_LEVEL=debug pnpm example:dev
MEDIA_CACHE_LOG_FORMAT=pretty MEDIA_CACHE_LOG_LEVEL=debug pnpm example:demo:nasa
MEDIA_CACHE_LOG_FORMAT=json pnpm example:smoke
```

The example UI exercises:

- sync status
- exact namespace listing
- namespace subtree listing
- item lookup by `(namespace, id)`
- exact file-stem lookup
- local image and video rendering from `media://` URLs in offline mode
- direct remote asset URLs in dev passthrough mode

## Main process

In offline mode, register the `media://` scheme before app readiness. In dev passthrough mode,
the renderer uses direct remote asset URLs instead.

```ts
import { app } from "electron";
import {
  createMediaCache,
  registerMediaCacheProtocolSchemes,
} from "@rockhallweb/electron-offline-content/main";

const devPassthrough = process.env.MEDIA_CACHE_DEV_PASSTHROUGH === "true";

if (!devPassthrough) {
  await registerMediaCacheProtocolSchemes();
}

const mediaCache = createMediaCache({
  // Explicit opt-in. Keep this off unless your dev assets are publicly reachable by URL.
  devPassthrough,
  // Optional dev-only origin override for public assets. Only used when devPassthrough is true.
  assetBaseUrl: devPassthrough ? "https://cdn.example.com" : undefined,
  logLevel: "info",
  onLog: (entry) => {
    console.log(entry);
  },
  resolveManifest: async () => ({
    namespaces: [
      {
        key: "nature",
        items: [
          {
            id: "forest",
            version: "v1",
            kind: "video",
            title: "Forest",
            assets: [
              {
                id: "main",
                role: "primary",
                kind: "video",
                fileName: "forest.mp4",
                source: {
                  url: "https://cdn.example.com/forest.v1.mp4",
                },
              },
            ],
          },
        ],
      },
    ],
  }),
});

await app.whenReady();
if (!devPassthrough) {
  await mediaCache.registerProtocol();
}
await mediaCache.attachIpc();
await mediaCache.start();
```

`onLog` receives the structured event object directly, so consumers can hand it off to a logger implementation of their choice without this package depending on a specific logging library. Notable warn-level events include `resolve_asset_base_url_fallback` (emitted when a stored asset URL cannot be parsed during origin override in passthrough mode; includes `context_label` and `error` fields).

`devPassthrough` is explicit opt-in and stays disabled unless the consumer sets it to `true`.

In passthrough mode:

- manifest metadata is still committed locally so the query APIs continue to work
- asset blobs are not downloaded
- `ResolvedMediaAsset.url` is a direct remote URL derived from the manifest asset source
- `media://asset/...` remains an offline-mode contract only
- startup is fail-fast and does not reuse a previously committed snapshot after restart

`assetBaseUrl` is an optional origin override for dev mode. It replaces only the origin of each manifest asset URL and preserves the original path and query string. For v1, it must be an origin only: no path, query string, hash fragment, or credentials.

Dev passthrough in v1 is intentionally limited to public assets. Assets that require signed URLs, per-request headers, or other authenticated request shaping are not supported in this mode yet.

The in-repo smoke and packed-smoke example runs explicitly force `devPassthrough: false` so CI still validates the offline cache path.

## Preload

```ts
import { exposeMediaCacheBridge } from "@rockhallweb/electron-offline-content/preload";

exposeMediaCacheBridge();
```

## React

```tsx
import {
  MediaCacheProvider,
  useMediaCacheStatus,
  useMediaNamespaceTree,
} from "@rockhallweb/electron-offline-content/react";

function App() {
  const status = useMediaCacheStatus();
  const items = useMediaNamespaceTree("nature", { limit: 20 });

  if (status.loading || items.loading) {
    return <div>Loading…</div>;
  }

  return (
    <div>
      {items.data?.items.map((item) => (
        <video key={`${item.namespace}/${item.id}`} src={item.assets[0]?.url} controls />
      ))}
    </div>
  );
}

export function Root() {
  return (
    <MediaCacheProvider>
      <App />
    </MediaCacheProvider>
  );
}
```

## Notes

- v1 requires consumers to own cache busting through manifest versions.
- v1 treats every asset as required for snapshot commit.
- `node:sqlite` is used for the local index, which is still marked experimental in Node 24.
