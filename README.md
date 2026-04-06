# `@rockhallweb/electron-offline-content`

Download, index, and serve offline media content in Electron apps.

- Full-catalog manifest sync with SQLite metadata index
- Disk-backed binary asset cache with atomic downloads
- Privileged `media://` protocol for renderer-safe local URLs
- Preload bridge and React hooks for renderer access
- Dev passthrough mode for local development without downloading assets

## Table of contents

- [When not to use this package](#when-not-to-use-this-package)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Quick start](#quick-start)
- [Manifest authoring](#manifest-authoring)
- [Dev passthrough mode](#dev-passthrough-mode)
- [Namespaces and content organization](#namespaces-and-content-organization)
- [Error handling and sync failures](#error-handling-and-sync-failures)
- [Authenticated asset downloads](#authenticated-asset-downloads)
- [Logging](#logging)
- [Storage limits](#storage-limits)
- [API reference](#api-reference)
- [Notes](#notes)
- [Example apps](#example-apps)

## When not to use this package

This package is opinionated. It codifies a specific content-sync model for kiosk-style Electron apps rather than trying to be a general-purpose cache layer.

- **General-purpose HTTP cache** -- this syncs a full manifest of offline content; it is not a generic fetch cache or service worker replacement.
- **Incremental or on-demand fetching** -- v1 syncs the entire catalog on every run. If your app needs lazy loading or partial sync, this is not the right fit.
- **Non-Electron apps** -- the package depends on Electron APIs (`app.getPath`, `session.protocol`, `contextBridge`).
- **Small ephemeral data** -- if you just need key-value storage or simple config persistence, `localStorage` or a lightweight store is simpler.

## Prerequisites

- Node.js >= 24 (`node:sqlite` is used for the local metadata index)
- pnpm >= 10
- Electron >= 40

## Install

```bash
pnpm add @rockhallweb/electron-offline-content
```

`react >= 18` and `react-dom >= 18` are optional peer dependencies, needed only when using `@rockhallweb/electron-offline-content/react`.

## Quick start

A minimal integration touches the main process, a preload script, and the renderer. The manifest typically comes from an external source (a CMS, an API, a static config), so we keep the fetch logic in its own file.

### 1. Fetch content and build a manifest

Create a module that fetches your content catalog and maps it into a manifest. This function will be called on every sync.

```ts
// fetch-content.ts
import {
  defineAsset,
  defineItem,
  defineManifest,
  itemsFromEntries,
} from "@rockhallweb/electron-offline-content/main";

export async function resolveManifest() {
  // Fetch your content catalog from a CMS, API, or any remote source.
  const response = await fetch("https://cms.example.com/api/videos");
  const videos = await response.json();

  return defineManifest({
    namespaces: {
      videos: {
        items: itemsFromEntries(videos, (video) => [
          video.slug,
          defineItem({
            version: video.updatedAt, // bump triggers re-download
            kind: "video",
            title: video.title,
            assets: {
              main: defineAsset({
                role: "primary",
                kind: "video",
                source: { url: video.fileUrl },
              }),
            },
          }),
        ]),
      },
    },
  });
}
```

### 2. Main process

Import your `resolveManifest` and wire up the cache. Create the cache **before** `app.whenReady()` so the privileged `media:` scheme registers in time.

```ts
// main.ts
import { app } from "electron";
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";
import { resolveManifest } from "./fetch-content.js";

const mediaCache = createMediaCache({
  storagePath: {
    appPath: "temp",
    segments: ["my-app", "offline-media"],
  },
  resolveManifest,
});

await app.whenReady();
await mediaCache.start(); // registers protocol, attaches IPC, runs initial sync
```

### 3. Preload

Expose the IPC bridge on `window.mediaCache` so the renderer can query the cache.

```ts
import { exposeMediaCacheBridge } from "@rockhallweb/electron-offline-content/preload";

exposeMediaCacheBridge();
```

### 4. Renderer (React)

Wrap your app in `MediaCacheProvider` and use hooks to access content.

```tsx
import {
  MediaCacheProvider,
  useMedia,
  useMediaBridge,
} from "@rockhallweb/electron-offline-content/react";

function App() {
  const media = useMedia({ kind: "list", namespace: "videos", limit: 20 });
  const { errors } = useMediaBridge();

  if (media.loading) {
    return <div>Loading...</div>;
  }
  if (errors.primaryError) {
    return <div>{errors.primaryError.message}</div>;
  }

  return (
    <div>
      {media.data?.items.map((item) => (
        <video
          key={`${item.namespace}/${item.id}`}
          src={item.assetsByRole.primary?.url ?? item.assets[0]?.url}
          controls
        />
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

## Manifest authoring

The manifest describes every piece of content and its downloadable assets. `resolveManifest` must return a full authoritative snapshot each time it is called -- the package diffs it against the local catalog and downloads only what changed.

### Manifest shape

A manifest has **namespaces**, each containing **items**, each containing **assets**:

```ts
{
  expiresAt: "2026-03-10T18:00:00.000Z", // optional global URL expiration cutoff
  namespaces: {
    lobby: {
      // map key is the stable namespace id
      label: "Lobby Kiosk", // optional display name
      items: {
        "spring-campaign": {
          // map key is the stable item id within this namespace
          version: "2026-03-10.1", // triggers re-download when changed
          kind: "video",
          title: "Spring Campaign",
          assets: {
            main: {
              role: "primary", // indexed on assetsByRole
              kind: "video",
              mimeType: "video/mp4",
              source: {
                url: "https://cdn.example.com/spring-campaign.mp4",
              },
            },
            poster: {
              role: "poster",
              kind: "poster",
              source: {
                url: "https://cdn.example.com/spring-campaign-poster.jpg",
              },
            },
          },
        },
      },
    },
  },
}
```

### Producer helpers

`defineManifest` validates your manifest with Zod before sync starts. Use it as the return value of `resolveManifest`. Build assets and items as standalone variables to keep nesting shallow and lines short:

```ts
import {
  defineAsset,
  defineItem,
  defineManifest,
} from "@rockhallweb/electron-offline-content/main";

const mainVideo = defineAsset({
  role: "primary",
  kind: "video",
  source: { url: "https://cdn.example.com/welcome.v2.mp4" },
});

const welcomeItem = defineItem({
  version: "v2",
  kind: "video",
  assets: { main: mainVideo },
});

const manifest = defineManifest({
  namespaces: {
    exhibits: {
      items: { welcome: welcomeItem },
    },
  },
});
```

`defineItem` and `defineAsset` validate their input individually, so errors surface at the point of definition rather than deep inside `defineManifest`.

If your manifest contains pre-signed asset URLs with a shared TTL, set `expiresAt` so the sync can fail fast with a clear error once those URLs are stale:

```ts
const manifest = defineManifest({
  expiresAt: "2026-03-10T18:00:00.000Z",
  namespaces: {
    exhibits: {
      items: { welcome: welcomeItem },
    },
  },
});
```

### Building records from arrays

When your source data is array-shaped, use `namespacesFromEntries`, `itemsFromEntries`, and `assetsFromEntries` to produce the `Record` maps `defineManifest` expects (see the [API reference](#api-reference)).

### Validation rules

- Namespace keys must be unique.
- Item IDs must be unique within a namespace.
- Asset IDs must be unique within an item.
- `item.version` is required (the package is version-driven for cache busting).
- `asset.version` is optional; when omitted, the parent `item.version` is used.
- `asset.fileName` is optional; when omitted, derived from the source URL basename.
- `manifest.expiresAt` is optional; when present, it must be an ISO 8601 timestamp with `Z` or an explicit UTC offset.
- Asset source URLs must be `http` or `https`.

## Dev passthrough mode

In dev passthrough mode, the package skips downloading asset blobs and returns direct remote URLs from the manifest instead of `media://` URLs. Manifest metadata is still committed locally so all query APIs continue to work.

`devPassthrough` defaults to `process.env.NODE_ENV === "development"`. You can override this explicitly:

```ts
const mediaCache = createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app"] },
  devPassthrough: process.env.FOO !== "true",
  resolveManifest: async () => manifest,
});
```

`assetBaseUrl` is an optional origin override for passthrough mode. It replaces only the origin of each manifest asset URL (preserving path and query string). It must be an origin only -- no path, query string, hash, or credentials.

**Limitations in v1:** dev passthrough is limited to public assets. Assets requiring signed URLs, per-request headers, or other authenticated request shaping are not supported in this mode. `resolveAssetRequest` is not called in passthrough mode. Startup is fail-fast (sync failures always throw; `onSyncFailure` is ignored).

## Namespaces and content organization

Namespaces let you organize content into logical groups (app sections, exhibits, kiosks). Use dot-delimited keys to create a hierarchy:

```ts
defineManifest({
  namespaces: {
    courses: {
      items: {
        /* top-level items */
      },
    },
    "courses.beginner": {
      items: {
        /* ... */
      },
    },
    "courses.advanced": {
      items: {
        /* ... */
      },
    },
  },
});
```

Query with `useMedia`:

```tsx
// Exact namespace only
const beginner = useMedia({ kind: "list", namespace: "courses.beginner", limit: 20 });

// Recursive: courses + courses.beginner + courses.advanced
const all = useMedia({ kind: "list", namespace: "courses", recursive: true, limit: 50 });
```

### File stem search

`useFileStemMatch` finds items by the normalized filename stem (name without extension) of their assets:

```tsx
const matches = useFileStemMatch("spring-campaign", { limit: 10 });
```

## Error handling and sync failures

### Sync failure modes

`onSyncFailure` controls what happens when a sync run fails while a previous generation exists on disk:

- `"serve-last-snapshot"` (default) -- the previous committed snapshot remains active. The cache continues serving content.
- `"throw"` -- the sync failure propagates. Use this when stale content is not acceptable.

```ts
const mediaCache = createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app"] },
  onSyncFailure: "throw",
  resolveManifest: async () => manifest,
});
```

### Error classes

All errors extend `MediaCacheError`, which carries a `code` string for programmatic handling:

| Error                     | Code                        | When                                                                |
| ------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `ManifestValidationError` | `MANIFEST_VALIDATION_ERROR` | Manifest is malformed (duplicate keys, missing fields)              |
| `ManifestExpiredError`    | `MANIFEST_EXPIRED`          | Manifest-declared asset URLs are past `expiresAt`                   |
| `DataValidationError`     | `DATA_VALIDATION_ERROR`     | Persisted state fails validation                                    |
| `StorageOwnershipError`   | `STORAGE_OWNERSHIP_ERROR`   | Another process or instance owns the storage root                   |
| `StorageLimitError`       | `STORAGE_LIMIT_ERROR`       | Disk full, `maxCacheBytes` exceeded, or `reserveFreeBytes` violated |
| `SyncFailureError`        | `SYNC_FAILURE`              | Network or HTTP failure downloading assets                          |

### Renderer error aggregation

`useMediaCacheErrors()` combines sync errors and all active query errors under the current `MediaCacheProvider` into a single view:

```tsx
const featured = useMedia({ kind: "item", namespace: "space", id: "hubble-cosmos" });
const catalog = useMedia({ kind: "list", namespace: "space", limit: 20 });
const errors = useMediaCacheErrors();

if (errors.hasError) {
  console.error(errors.primaryError);
}
```

`errors.primaryError` is the single most relevant error for display. `errors.syncError`, `errors.statusError`, and `errors.queryErrors` are available for more granular handling.

## Authenticated asset downloads

For assets behind authentication, use `resolveAssetRequest` to customize the download request just before each fetch. The callback receives `{ namespace, item, asset }` context and returns a `DownloadRequest` with `url`, optional `method`, and optional `headers`. When omitted, the package uses `asset.source` as-is.

**Signed URLs** -- generate a short-lived URL per asset at download time:

```ts
const mediaCache = createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app"] },
  resolveManifest: async () => manifest,
  resolveAssetRequest: async (ctx) => ({
    url: await getSignedUrl(ctx.asset.source.url),
  }),
});
```

If you embed pre-signed URLs directly in the manifest instead, use a generous TTL and set `manifest.expiresAt` to the earliest shared expiry. The cache checks `expiresAt` immediately after manifest resolution and again before each late-queue request is resolved and fetched, so once `now >= expiresAt` the run fails with `MANIFEST_EXPIRED` instead of surfacing a later opaque HTTP 403.

**Bearer token** -- attach an auth header to stable URLs:

```ts
const mediaCache = createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app"] },
  resolveManifest: async () => manifest,
  resolveAssetRequest: async (ctx) => ({
    url: ctx.asset.source.url,
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
    },
  }),
});
```

If your token is long-lived and known at manifest build time, you can skip `resolveAssetRequest` and set headers directly on the asset source:

```ts
const asset = defineAsset({
  role: "primary",
  kind: "video",
  source: {
    url: "https://cdn.example.com/asset.mp4",
    headers: { Authorization: "Bearer <token>" },
  },
});
```

## Logging

When `logging?.onLog` is omitted and `NODE_ENV` is not `"production"`, the package prints to the main-process console. Lines are human-readable English by default.

### Custom log sink

Pass `logging.onLog` to receive structured `MediaCacheLogEvent` objects and forward them to your logger (pino, logtape, etc.):

```ts
const mediaCache = createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app"] },
  logging: {
    level: "info",
    onLog: (entry) => {
      logger.log(entry.level, entry.event, entry);
    },
  },
  resolveManifest: async () => manifest,
});
```

### Built-in console formatting

Use `logging.format` only when you want the package's built-in development console sink:

```ts
const mediaCache = createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app"] },
  logging: {
    level: "debug",
    format: "json",
  },
  resolveManifest: async () => manifest,
});
```

### Breaking migration

As of `0.2.0`, the flat `onLog`, `logLevel`, and `logFormat` options have been removed. Migrate to the nested `logging` object:

```ts
// Before
createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app"] },
  onLog: (entry) => logger.info(entry, entry.event),
  logLevel: "info",
  resolveManifest: async () => manifest,
});

// After
createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app"] },
  logging: {
    onLog: (entry) => logger.info(entry, entry.event),
    level: "info",
  },
  resolveManifest: async () => manifest,
});
```

`logging.format` is only valid for the built-in console sink and cannot be combined with `logging.onLog`.

### Log options

| Option           | Default                                  | Description                                                                         |
| ---------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `logging.onLog`  | `undefined`                              | Structured log callback. Replaces the built-in console sink.                        |
| `logging.level`  | `"debug"` (console) / `"info"` (`onLog`) | Minimum severity emitted.                                                           |
| `logging.format` | `"english"`                              | Built-in console line format: `"english"` or `"json"`. Cannot be used with `onLog`. |

### Notable events

- `resolve_asset_base_url_fallback` (warn) -- a stored asset URL could not be parsed during origin override in passthrough mode.
- `dev_passthrough_ignores_sync_failure_mode` (warn) -- `devPassthrough` is true and `onSyncFailure` is not `"throw"`.
- `manifest_expired` (warn) -- the manifest declared `expiresAt` and the sync reached or passed it before download work completed.
- `protocol_request_not_found` (debug) -- no matching generation or asset for a `media://` request.
- `protocol_request_file_missing` (debug) -- asset exists in DB but file is absent on disk.

## Storage limits

Configure disk usage guardrails to prevent the cache from consuming unbounded space:

```ts
const mediaCache = createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app"] },
  maxCacheBytes: 10 * 1024 * 1024 * 1024, // 10 GB
  reserveFreeBytes: 1 * 1024 * 1024 * 1024, // keep 1 GB free
  staleDeleteAfterMs: 7 * 24 * 60 * 60 * 1000, // 7 days (default)
  resolveManifest: async () => manifest,
});
```

| Option               | Default     | Description                                                                 |
| -------------------- | ----------- | --------------------------------------------------------------------------- |
| `maxCacheBytes`      | `undefined` | Soft cap on total bytes of cached asset files.                              |
| `reserveFreeBytes`   | `undefined` | Minimum free disk space to preserve on the volume.                          |
| `staleDeleteAfterMs` | 7 days      | Grace period before assets removed from the manifest are deleted from disk. |

When limits are exceeded, the sync raises `StorageLimitError`. The configured `onSyncFailure` mode then applies.

Assets removed from the manifest are not deleted immediately. They are marked for grace-period deletion and pruned after `staleDeleteAfterMs` expires.

## API reference

### `@rockhallweb/electron-offline-content/main`

#### `createMediaCache(options)`

Creates a `MediaCacheMain` instance. Call before `app.whenReady()` in offline mode.

**`MediaCacheOptions`**

| Option                | Type                       | Required | Description                                                                                     |
| --------------------- | -------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `storagePath`         | `MediaCacheStoragePath`    | yes      | `{ appPath, segments? }` -- resolved via `app.getPath(appPath)` plus optional subpath segments. |
| `resolveManifest`     | callback                   | yes      | Returns `MediaCacheManifest` or a `Promise` of it for each sync.                                |
| `devPassthrough`      | `boolean`                  | no       | Skip downloads, return remote URLs. Auto-enabled when `NODE_ENV === "development"`.             |
| `assetBaseUrl`        | `string`                   | no       | Origin override for dev passthrough (origin only, no path/query/hash).                          |
| `onSyncFailure`       | `SyncFailureMode`          | no       | Behavior when a sync fails after a prior snapshot exists (`serve-last-snapshot` or `throw`).    |
| `resolveAssetRequest` | callback                   | no       | Optional per-asset hook: given context, return `DownloadRequest` or a `Promise` of it.          |
| `maxCacheBytes`       | `number`                   | no       | Soft cap on total cached bytes.                                                                 |
| `reserveFreeBytes`    | `number`                   | no       | Minimum free disk bytes to preserve.                                                            |
| `staleDeleteAfterMs`  | `number`                   | no       | Grace period (ms) before pruning removed assets. Default 7 days.                                |
| `syncHistoryLimit`    | `number`                   | no       | Max completed sync runs retained in SQLite. Default 50.                                         |
| `logging`             | `MediaCacheLoggingOptions` | no       | Nested logging config for either a custom sink or built-in console formatting.                  |

#### `MediaCacheMain`

Returned by `createMediaCache`. Requires exclusive ownership of its resolved storage root.

| Method                                   | Returns                                               | Description                                                       |
| ---------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `start()`                                | `Promise<void>`                                       | One-call setup: register protocol, attach IPC, run initial sync.  |
| `syncNow()`                              | `Promise<void>`                                       | Run or join a sync. Concurrent callers share one run.             |
| `getStatus()`                            | `Promise<MediaCacheStatus>`                           | Current phase, progress, last run, and error.                     |
| `getItem(namespace, id)`                 | `Promise` (nullable)                                  | Resolves to `ResolvedMediaContentItem` or `null` if missing.      |
| `listNamespace(namespace, pagination?)`  | `Promise<PaginationResult<ResolvedMediaContentItem>>` | Flat list of items in one namespace.                              |
| `listNamespaceTree(prefix, pagination?)` | `Promise<PaginationResult<ResolvedMediaContentItem>>` | Items under a namespace prefix and all descendants.               |
| `findByFileStem(stem, options?)`         | `Promise<PaginationResult<FileStemMatch>>`            | Search by normalized filename stem.                               |
| `registerProtocol(options?)`             | `Promise<void>`                                       | Register the `media:` handler on a session.                       |
| `attachIpc(options?)`                    | `Promise<void>`                                       | Wire `ipcMain` handlers and broadcast status to renderer windows. |

In kiosk-style apps, call `app.requestSingleInstanceLock()` before constructing the cache. The package enforces storage-root exclusivity itself, but the instance lock prevents a second Electron process from launching.

#### `defineManifest(input)`

Validates and returns a `MediaCacheManifest`. Runs Zod validation and internal normalization checks.

#### `defineItem(input)` / `defineAsset(input)`

Granular validation helpers for individual item and asset **values** (ids live on the parent `Record` keys, not on these objects). `defineAsset` may derive `fileName` from the source URL when omitted.

#### `namespacesFromEntries` / `itemsFromEntries` / `assetsFromEntries`

Build `namespaces`, `items`, or `assets` records from arrays while validating entries and rejecting duplicate keys.

#### Key types

**MediaCacheManifest** -- `{ snapshotId?, retrievedAt?, expiresAt?, namespaces: Record<string, MediaNamespaceValue> }`

**MediaNamespaceValue** -- `{ label?, metadata?, items: Record<string, MediaItemValue> }`

**MediaItemValue** -- `{ version, kind, title?, description?, summary?, blobs?, metadata?, assets: Record<string, MediaAssetValue> }`

**MediaAssetValue** -- `{ role, kind, version?, mimeType?, fileName?, byteLength?, source: { url, method?, headers? }, metadata? }`

**ResolvedMediaContentItem** -- returned by queries. Includes `namespace`, `id`, `version`, `kind`, `title`, `description`, `summary`, `blobs`, `metadata`, `assets: ResolvedMediaAsset[]`, and `assetsByRole: Record<string, ResolvedMediaAsset | undefined>`.

**ResolvedMediaAsset** -- `{ id, role, kind, mimeType?, byteLength?, url, metadata }`. `url` is a `media://` URL in offline mode or a remote URL in passthrough mode.

**MediaCacheStatus** -- `{ phase, storageRoot, activeGenerationId, progress, lastRun, error, updatedAt }`. `phase` is `"idle" | "syncing" | "ready" | "error"`.

**FileStemMatch** -- `{ item: ResolvedMediaContentItem, matchedAssetIds: string[] }`

**PaginationInput** -- `{ limit?, cursor? }`

**`PaginationResult<T>`** -- `{ items: T[], nextCursor: string | null }`

See the published `.d.ts` files for full type definitions.

### `@rockhallweb/electron-offline-content/preload`

#### `exposeMediaCacheBridge(options?)`

Calls `contextBridge.exposeInMainWorld` to put the `MediaCacheBridge` on `window.mediaCache` (or a custom key via `options.key`). Returns the bridge instance.

#### `createMediaCacheBridge()`

Builds a `MediaCacheBridge` without calling `contextBridge`. Use this if you manage `contextBridge` yourself.

### `@rockhallweb/electron-offline-content/react`

All hooks require a `MediaCacheProvider` ancestor (or `window.mediaCache` as fallback).

#### `MediaCacheProvider`

Context provider. If your preload uses the default `window.mediaCache` key, you can omit the `bridge` prop.

```tsx
<MediaCacheProvider bridge={customBridge}>
  <App />
</MediaCacheProvider>
```

#### `useMediaBridge()`

Returns the active bridge methods together with shared `status`, top-level composite `phase` (`MediaCachePhase`: cache phase or `"loading"` before the first snapshot), and aggregated `errors`.

```tsx
const { syncNow, status, phase, errors } = useMediaBridge();
```

Use this when you need imperative bridge access without wiring separate status and error hooks.

#### `useMediaCacheStatus()`

Returns `UseMediaCacheStatusResult`: the same fields as `AsyncState<MediaCacheStatus>` plus top-level `phase` (`MediaCachePhase`). Subscribes to live status updates and exposes `refresh()`.

#### `useMedia(options)`

Primary React query hook. Use `{ kind: "item", namespace, id, refetchOnSyncComplete? }` for a single item, or `{ kind: "list", namespace, recursive?, limit?, cursor?, refetchOnSyncComplete? }` for a namespace list/tree.

Returns either:

- `UseMediaItemResult` for item lookups (includes `phase`, `status`, and `errors`)
- `UseMediaListResult` for namespace and namespace-tree lookups (includes `phase`, `status`, and `errors`)

#### `useFileStemMatch(stem, options?)`

Returns `AsyncState<PaginationResult<FileStemMatch>>`. Searches by normalized filename stem.

Options: `{ namespace?, limit?, cursor?, refetchOnSyncComplete? }`

#### `useMediaCacheReady()`

Returns `AsyncState<MediaCacheReadyState>`. Lightweight readiness gate: `{ ready, syncing, phase, activeGenerationId, syncError }`.

```tsx
const ready = useMediaCacheReady();
if (!ready.data?.ready) return <p>Preparing offline content...</p>;
```

#### `useMediaCacheErrors()`

Aggregates sync and provider-wide query errors into `MediaCacheErrors`: `{ syncError, statusError, queryErrors, hasError, primaryError }`.

#### `AsyncState<T>`

Hooks such as `useFileStemMatch`, `useMediaCacheReady`, and `useMediaCacheStatus` return this shape. `useMedia()` adds shared `status` and `errors` on top of it:

```ts
{
  data: T | null; // latest resolved value
  loading: boolean; // true during initial load or refresh
  error: Error | null; // last request error
  refresh: () => Promise<void>;
}
```

## Notes

- v1 requires consumers to own cache busting through manifest versions.
- v1 treats every asset as required for snapshot commit.
- Storage root exclusivity: `MediaCache` acquires exclusive ownership of its `storageRoot`. If `start()` fails after ownership is established, reuse the same instance or restart the process rather than constructing a replacement cache for the same root.

## Example apps

Two example apps demonstrate end-to-end wiring. Each is a standalone Electron Forge + React + Vite project.

- [examples/local/](examples/local/) -- uses a loopback HTTP server with small local fixtures. Also used by `pack:verify` in CI.
- [examples/nasa/](examples/nasa/) -- uses public NASA SVS URLs for heavier manual demos (not run in CI).

Both examples exercise sync status, namespace listing, namespace tree listing, item lookup, file-stem search, and rendering images and video from `media://` URLs (offline mode) or direct remote URLs (dev passthrough).

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the examples locally.
