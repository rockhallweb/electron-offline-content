# `@rockhallweb/electron-offline-content`

A package for Electron apps to download, stage, and serve offline content from a remote source. Supports video, images, audio, text content, and more.

## Repository layout

- **Root package** — `@rockhallweb/electron-offline-content` (library source and published `dist/` output).
- **`pnpm-workspace.yaml`** — Declares only the root package (`packages: ["."]`) so the root `pnpm-lock.yaml` stays limited to the library. Without this, pnpm can treat nested `package.json` files as extra importers and merge example dependencies into the root lockfile.
- **Example apps** — `examples/local` and `examples/nasa` are standalone pnpm projects (each has its own `pnpm-lock.yaml`). They depend on the root package via a local path (`../../`). A root `pnpm install` installs only the library; install example dependencies with `pnpm install:example:local` / `pnpm install:example:nasa` (or `pnpm install` inside each example directory).

Each example is a small Electron Forge + React + Vite app that shows how to wire the library end-to-end. The linked package resolves to compiled files under `dist/`; if you run `pnpm dev` from an example directory, `predev` builds the root package when `dist/` is missing.

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
  Run Oxlint across the repository source and config files.
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
- `pnpm install:example:local`
  Install dependencies for `examples/local`.
- `pnpm install:example:nasa`
  Install dependencies for `examples/nasa`.
- `pnpm example:local:dev`
  Build the library and launch the local-fixtures Electron Forge example.
- `pnpm example:nasa:dev`
  Build the library and launch the NASA-hosted media Electron Forge example.
- `pnpm pack:verify`
  Pack the root package into a tarball, install that tarball into a temporary copy of `examples/local`, and run `tsc --noEmit` against the example’s main/preload sources (`tsconfig.pack-verify.json`) to catch publish/install resolution issues.
- `pnpm ci:validate`
  Run the full maintainer validation chain: lint, format check, type-check, test, build, and `pack:verify`.

GitHub Actions uses the same `pnpm ci:validate` entrypoint. The workflow is restricted to member-controlled branches and same-repository PRs; see [`docs/ci.md`](docs/ci.md) for the repository-side policy and required GitHub settings.

Day-to-day development uses a path-linked example plus root `pnpm build`. `pnpm pack:verify` exercises the same install path consumers get from the registry tarball (using `examples/local`) and helps catch export or packaging mistakes that path linking can hide.

## Example apps

- **`examples/local`** — tiny fixtures served from a loopback HTTP server; used by `pnpm pack:verify`.
- **`examples/nasa`** — public NASA SVS URLs for heavier manual demos (not run in CI).

Run:

```bash
pnpm example:local:dev
pnpm example:nasa:dev
```

The examples hardcode cache settings and UI labels so the code stays easy to read. In production you will typically drive `storageRoot` and similar values from `process.env`, a config file, or your installer. Enable dev passthrough only when you need the escape hatch (see below).

The example UIs exercise:

- sync status
- exact namespace listing
- namespace subtree listing
- item lookup by `(namespace, id)`
- exact file-stem lookup
- local image and video rendering from `media://` URLs in offline mode
- direct remote asset URLs in dev passthrough mode

## Main process

Default behavior is **offline mode**: the package registers the privileged `media:` scheme when you construct the cache (no separate registration call), syncs assets to disk, and resolves `media://asset/...` URLs for the renderer.

1. Call `createMediaCache(...)` in the main process **before** `app.whenReady()` so scheme registration can run in time.
2. After `app.whenReady()`, call `registerProtocol()`, `attachIpc()`, and `start()` (or `syncNow()`).

```ts
import { app } from "electron";
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";

const mediaCache = createMediaCache({
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
await mediaCache.registerProtocol();
await mediaCache.attachIpc();
await mediaCache.start();
```

**Escape hatch — dev passthrough:** omit the properties below unless you need direct remote URLs in the renderer (e.g. public assets reachable without your normal offline sync). When enabled, `registerProtocol()` becomes a no-op for the default session (no `media://` handler needed).

```ts
const mediaCache = createMediaCache({
  devPassthrough: true,
  assetBaseUrl: "https://cdn.example.com",
  resolveManifest: async () => {
    /* same manifest shape as offline mode */
    return { namespaces: [] };
  },
});
```

`onLog` receives the structured event object directly, so consumers can hand it off to a logger implementation of their choice without this package depending on a specific logging library. Namespace, item ID, prefix, and file stem arguments are validated (min 1, max 2000 characters); invalid values throw `DataValidationError`.

Notable warn-level events include `resolve_asset_base_url_fallback` (emitted when a stored asset URL cannot be parsed during origin override in passthrough mode; includes `context_label` and `error` fields) and `dev_passthrough_ignores_sync_failure_mode` (emitted when `devPassthrough: true` and `onSyncFailure !== "throw"`; sync failures always throw in dev passthrough regardless). These warnings are only emitted when `onLog` is configured. Debug-level protocol events include `protocol_request_not_found` (no matching generation or asset for a `media://` request) and `protocol_request_file_missing` (asset exists in DB but file is absent on disk).

In passthrough mode:

- manifest metadata is still committed locally so the query APIs continue to work
- asset blobs are not downloaded
- `ResolvedMediaAsset.url` is a direct remote URL derived from the manifest asset source
- `media://asset/...` remains an offline-mode contract only
- startup is fail-fast and does not reuse a previously committed snapshot after restart

`assetBaseUrl` is an optional origin override for dev mode. It replaces only the origin of each manifest asset URL and preserves the original path and query string. For v1, it must be an origin only: no path, query string, hash fragment, or credentials.

Dev passthrough in v1 is intentionally limited to public assets. Assets that require signed URLs, per-request headers, or other authenticated request shaping are not supported in this mode yet.

`pnpm pack:verify` validates that the packed library installs cleanly into `examples/local`; it does not launch Electron. The examples use default offline mode unless you opt into dev passthrough in source.

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
