# `@rockhall/electron-offline-content`

Download, index, and serve offline media content in Electron apps.

- Flat key-value asset store with user-defined secondary indexes
- Disk-backed binary asset cache with atomic downloads
- Privileged `media://` protocol for renderer-safe local URLs
- Preload bridge and framework-agnostic renderer client
- Dev passthrough mode for local development without downloading assets

## Table of contents

- [When not to use this package](#when-not-to-use-this-package)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Quick start](#quick-start)
- [Store authoring](#store-authoring)
- [Secondary indexes and querying](#secondary-indexes-and-querying)
- [Dev passthrough mode](#dev-passthrough-mode)
- [Signed URLs and authentication](#signed-urls-and-authentication)
- [Error handling and sync failures](#error-handling-and-sync-failures)
- [Logging](#logging)
- [Storage limits](#storage-limits)
- [API reference](#api-reference)
- [Notes](#notes)
- [Example apps](#example-apps)

## When not to use this package

This package is opinionated. It codifies a specific content-sync model for kiosk-style Electron apps rather than trying to be a general-purpose cache layer.

- **General-purpose HTTP cache** -- this syncs a full asset store of offline content; it is not a generic fetch cache or service worker replacement.
- **Incremental or on-demand fetching** -- v1 syncs the entire catalog on every run. If your app needs lazy loading or partial sync, this is not the right fit.
- **Non-Electron apps** -- the package depends on Electron APIs (`app.getPath`, `session.protocol`, `contextBridge`).
- **Small ephemeral data** -- if you just need key-value storage or simple config persistence, `localStorage` or a lightweight store is simpler.

## Prerequisites

- Node.js >= 24 (`node:sqlite` is used for the local metadata index)
- pnpm 11.1.0
- Electron >= 40

## Install

```bash
pnpm add @rockhall/electron-offline-content
```

## Quick start

A minimal integration touches the main process, a preload script, and the renderer. The store typically comes from an external source (a CMS, an API, a static config), so we keep the build logic in its own file.

### 1. Build a store

Create a module that fetches your content catalog and builds a flat asset store. This function will be called on every sync.

```ts
// fetch-content.ts
import { createMediaStore } from "@rockhall/electron-offline-content/main";

export async function resolveStore() {
  const response = await fetch("https://cms.example.com/api/videos");
  const videos = await response.json();

  const store = createMediaStore();
  const collection = store.defineIndex("collection");

  for (const video of videos) {
    store.add(["videos", video.slug, "main"], {
      version: video.updatedAt,
      mimeType: "video/mp4",
      url: video.fileUrl,
      indexes: [collection("videos")],
    });
  }

  return store;
}
```

### 2. Main process

Import your `resolveStore` and wire up the cache. Create the cache **before** `app.whenReady()` so the privileged `media:` scheme registers in time.

```ts
// main.ts
import { app } from "electron";
import { createMediaCache } from "@rockhall/electron-offline-content/main";
import { resolveStore } from "./fetch-content.js";

const mediaCache = createMediaCache({
  storagePath: {
    appPath: "temp",
    segments: ["my-app", "offline-media"],
  },
  resolveStore,
});

await app.whenReady();
await mediaCache.start(); // registers protocol, attaches IPC, runs initial sync
```

### 3. Preload

Expose the IPC bridge on `window.mediaCache` so the renderer can query the cache.

```ts
import { exposeMediaCacheBridge } from "@rockhall/electron-offline-content/preload";

exposeMediaCacheBridge();
```

### 4. Renderer

Use the framework-agnostic renderer client to query the preload bridge and subscribe to async state updates.

```ts
import { createMediaCacheRenderer } from "@rockhall/electron-offline-content/renderer";

const renderer = createMediaCacheRenderer();
const container = document.querySelector<HTMLDivElement>("#videos");

const unsubscribe = renderer.watchMediaByIndex("collection", "videos", { limit: 20 }, (videos) => {
  if (!container) {
    return;
  }

  if (videos.loading) {
    container.textContent = "Loading...";
    return;
  }

  if (videos.error) {
    container.textContent = videos.error.message;
    return;
  }

  container.replaceChildren(
    ...(videos.data?.items ?? []).map((asset) => {
      const video = document.createElement("video");
      video.src = asset.url;
      video.title = asset.displayKey;
      video.controls = true;
      return video;
    }),
  );
});

window.addEventListener("beforeunload", () => {
  unsubscribe();
  renderer.dispose();
});
```

Apps can use this renderer client from router loaders, component state, framework-managed lifecycles, or any other data-loading layer.

## Store authoring

The store describes every downloadable asset and its metadata. `resolveStore` must return a full authoritative snapshot each time it is called -- the package diffs it against the local catalog and downloads only what changed.

### Store shape

A store is a flat collection of keyed **assets**, each tagged with optional **secondary indexes**:

```ts
import { createMediaStore } from "@rockhall/electron-offline-content/main";

const store = createMediaStore({
  expiresAt: "2026-03-10T18:00:00.000Z", // optional global URL expiration cutoff
});

const gallery = store.defineIndex("gallery");
const role = store.defineIndex("role");

store.add(["lobby", "spring-campaign", "video"], {
  version: "2026-03-10.1",
  mimeType: "video/mp4",
  url: "https://cdn.example.com/spring-campaign.mp4",
  indexes: [gallery("lobby"), role("primary")],
});

store.add(["lobby", "spring-campaign", "poster"], {
  version: "2026-03-10.1",
  mimeType: "image/jpeg",
  url: "https://cdn.example.com/spring-campaign-poster.jpg",
  indexes: [gallery("lobby"), role("poster")],
});
```

Pass a non-empty string or a non-empty array of non-empty string segments as the first argument to `store.add()` (the `AssetKeyInput` type). Segments are joined for a human-readable `displayKey` on resolved assets; internally the package stores a **SHA-256 hash** (first 16 hex characters) as the stable `key`. Either form can be used with `getAsset()` as long as it matches what you passed to `add()`.

### Building stores from arrays

When your source data is array-shaped, iterate and call `store.add` for each entry:

```ts
import {
  createMediaStore,
} from "@rockhall/electron-offline-content/main";

type VideoRow = {
  id: string;
  version: string;
  title: string;
  fileUrl: string;
  posterUrl: string;
};

const videos: VideoRow[] = /* from CMS/API */;

const store = createMediaStore();
const collection = store.defineIndex("collection");

for (const v of videos) {
  store.add(["videos", v.id, "main"], {
    version: v.version,
    mimeType: "video/mp4",
    url: v.fileUrl,
    metadata: { title: v.title },
    indexes: [collection("videos")],
  });
  store.add(["videos", v.id, "poster"], {
    version: v.version,
    mimeType: "image/jpeg",
    url: v.posterUrl,
    metadata: { title: v.title },
    indexes: [collection("videos")],
  });
}
```

### Callable index handles and `IndexTag`

`store.defineIndex` returns a `MediaIndex` value: a callable function (typed as an interface) plus read-only metadata (`indexName`, `cardinality`, `required`). Call the handle with a string (single-value indexes) or `string[]` (multi-value indexes) to produce an `IndexTag` instance. Pass those tags in the `indexes` array on each `store.add(assetKey, input)` call (`assetKey` is `AssetKeyInput`):

```ts
const gallery = store.defineIndex("gallery");

store.add(["photos", "photo-1"], {
  version: "v1",
  mimeType: "image/jpeg",
  url: "https://cdn.example.com/photo-1.jpg",
  indexes: [gallery("nature")],
});

store.add(["photos", "photo-2"], {
  version: "v1",
  mimeType: "image/jpeg",
  url: "https://cdn.example.com/photo-2.jpg",
  indexes: [gallery("wildlife")],
});

// Index name is available on the handle without invoking it
console.log(gallery.indexName); // "gallery"
```

### Signed URL expiration

If your store contains pre-signed asset URLs with a shared TTL, set `expiresAt` so the sync fails fast with a clear error once those URLs are stale:

```ts
const store = createMediaStore({
  expiresAt: "2026-03-10T18:00:00.000Z",
});
```

The cache checks `expiresAt` immediately after store resolution and again before each late-queue download starts, so once `now >= expiresAt` the run fails with `STORE_EXPIRED` instead of surfacing a later opaque HTTP 403.

### Validation rules

- Asset keys must be unique (storage identity is a SHA-256–derived hash; duplicates are rejected).
- Key inputs must be a non-empty string or a non-empty array of non-empty strings; there is no further key content validation.
- `version` is required on every asset (the package is version-driven for cache busting).
- `mimeType` is required and must be a valid `type/subtype` string.
- `fileName` is optional; when omitted, derived from the URL basename.
- `url` must use `http` or `https`.
- `expiresAt` is optional; when present, it must be an ISO 8601 timestamp.
- Indexes referenced in `store.add` must have been declared with `store.defineIndex` first.
- Built-in index names (`mimeType`, `mediaKind`) cannot be used with `defineIndex`.

## Secondary indexes and querying

Indexes are the primary way to organize and query assets in the flat store.

### Defining indexes

Call `store.defineIndex(name)` before adding assets that reference the index. Each index has a cardinality (`"single"` or `"multi"`) and can be marked as required:

```ts
const store = createMediaStore();

// Single-value index (default): each asset maps to one string value
const collection = store.defineIndex("collection");

// Multi-value index: each asset can map to multiple string values
const tags = store.defineIndex("tags", { cardinality: "multi" });

// Required index: every asset must provide a value
const category = store.defineIndex("category", { required: true });
```

### Tagging assets with indexes

Pass `IndexTag` values in the `indexes` array when calling `store.add` (each tag comes from calling a `defineIndex` handle):

```ts
store.add(["forest", "video"], {
  version: "v1",
  mimeType: "video/mp4",
  url: "https://cdn.example.com/forest.mp4",
  indexes: [collection("nature"), tags(["forest", "outdoor", "4k"]), category("video")],
});
```

### Querying by index

From the main process, use `cache.listByIndex(indexName, value)`:

```ts
const natureVideos = await mediaCache.listByIndex("collection", "nature", { limit: 20 });
```

From the renderer, use the preload-backed renderer client:

```ts
import { createMediaCacheRenderer } from "@rockhall/electron-offline-content/renderer";

const renderer = createMediaCacheRenderer();
const natureVideos = await renderer.bridge.listByIndex("collection", "nature", { limit: 20 });
```

### Built-in indexes

Two indexes are automatically populated for every asset without any `defineIndex` call:

| Index       | Source                                          | Example values                                                                |
| ----------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `mimeType`  | The asset's `mimeType` field                    | `"video/mp4"`, `"image/jpeg"`                                                 |
| `mediaKind` | Derived from `mimeType` via `mediaKindFromMime` | `"video"`, `"image"`, `"audio"`, `"document"`, `"html"`, `"text"`, `"binary"` |

Query all images:

```ts
const images = await renderer.bridge.listByIndex("mediaKind", "image", { limit: 50 });
```

### Namespace-like grouping via indexes

If your app has a namespace concept, model it as an index:

```ts
const namespace = store.defineIndex("namespace");

store.add(["lobby", "welcome-video"], {
  version: "v1",
  mimeType: "video/mp4",
  url: "https://cdn.example.com/welcome.mp4",
  indexes: [namespace("lobby")],
});

store.add(["exhibits", "hubble"], {
  version: "v1",
  mimeType: "image/jpeg",
  url: "https://cdn.example.com/hubble.jpg",
  indexes: [namespace("exhibits")],
});
```

Then query:

```ts
const lobbyAssets = await renderer.bridge.listByIndex("namespace", "lobby", { limit: 20 });
```

### File stem search

`findByFileStem` finds assets by the normalized filename stem (name without extension) of their download URL:

```ts
const matches = await renderer.bridge.findByFileStem("spring-campaign", { limit: 10 });
```

## Dev passthrough mode

In dev passthrough mode, the package skips downloading asset blobs and returns direct remote URLs from the store instead of `media://` URLs. Store metadata is still committed locally so all query APIs continue to work.

`devPassthrough` defaults to `process.env.NODE_ENV === "development"`. You can override this explicitly:

```ts
const mediaCache = createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app"] },
  devPassthrough: process.env.FOO !== "true",
  resolveStore: async () => store,
});
```

`assetBaseUrl` is an optional origin override for passthrough mode. It replaces only the origin of each asset's URL (preserving path and query string). It must be an origin only -- no path, query string, hash, or credentials.

**Limitations in v1:** dev passthrough is limited to public assets. Assets that require signed URLs or other authenticated downloads are not supported in this mode unless the URL itself embeds auth (for example a presigned URL). Startup is fail-fast (sync failures always throw; `onSyncFailure` is ignored).

## Signed URLs and authentication

Downloads use a plain `GET` to each asset’s `url` string. There is no separate per-asset request hook and no support for custom HTTP methods or headers—put credentials into the URL (typically a presigned URL) when you build the store in `resolveStore()`.

**Signed URLs** -- generate pre-signed URLs at store build time:

```ts
import { createMediaStore } from "@rockhall/electron-offline-content/main";

async function resolveStore() {
  const store = createMediaStore({
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), // 1 hour
  });

  const videos = await fetchCatalog();
  for (const video of videos) {
    const signedUrl = await getS3PresignedUrl(video.s3Key);
    store.add(["videos", video.id], {
      version: video.version,
      mimeType: "video/mp4",
      url: signedUrl,
    });
  }

  return store;
}
```

Set `expiresAt` on the store to the earliest shared URL expiry. The cache checks `expiresAt` immediately after store resolution and again before each download starts, so expired URLs fail with `STORE_EXPIRED` rather than an opaque HTTP 403.

## Error handling and sync failures

### Sync failure modes

`onSyncFailure` controls what happens when a sync run fails while a previous generation exists on disk:

- `"serve-last-snapshot"` (default) -- the previous committed snapshot remains active. The cache continues serving content.
- `"throw"` -- the sync failure propagates. Use this when stale content is not acceptable.

```ts
const mediaCache = createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app"] },
  onSyncFailure: "throw",
  resolveStore: async () => store,
});
```

### Error classes

All errors extend `MediaCacheError`, which carries a `code` string for programmatic handling:

| Error                   | Code                      | When                                                                   |
| ----------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `StoreValidationError`  | `STORE_VALIDATION_ERROR`  | Store is malformed (duplicate keys, missing fields, undefined indexes) |
| `StoreExpiredError`     | `STORE_EXPIRED`           | Store-declared asset URLs are past `expiresAt`                         |
| `DataValidationError`   | `DATA_VALIDATION_ERROR`   | Persisted state fails validation                                       |
| `StorageOwnershipError` | `STORAGE_OWNERSHIP_ERROR` | Another process or instance owns the storage root                      |
| `StorageLimitError`     | `STORAGE_LIMIT_ERROR`     | Disk full, `maxCacheBytes` exceeded, or `reserveFreeBytes` violated    |
| `SyncFailureError`      | `SYNC_FAILURE`            | Network or HTTP failure downloading assets                             |

### Renderer error aggregation

`aggregateMediaCacheErrors()` combines status loading errors, sync errors, and active query errors into a single view:

```ts
import {
  aggregateMediaCacheErrors,
  createMediaCacheRenderer,
  type MediaAsyncState,
  type MediaCacheStatus,
} from "@rockhall/electron-offline-content/renderer";

const renderer = createMediaCacheRenderer();
let statusState: MediaAsyncState<MediaCacheStatus> = {
  data: null,
  loading: true,
  error: null,
  refresh: async () => undefined,
};
const queryErrors: Error[] = [];

const unsubscribeStatus = renderer.subscribeCacheStatus((nextStatus) => {
  statusState = nextStatus;
  const errors = aggregateMediaCacheErrors(statusState, queryErrors);

  if (errors.hasError) {
    console.error(errors.primaryError);
  }
});

// Call during route/component teardown.
unsubscribeStatus();
```

`errors.primaryError` is the single most relevant error for display. `errors.syncError`, `errors.statusError`, and `errors.queryErrors` are available for more granular handling.

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
  resolveStore: async () => store,
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
  resolveStore: async () => store,
});
```

### Log options

| Option           | Default                                  | Description                                                                         |
| ---------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `logging.onLog`  | `undefined`                              | Structured log callback. Replaces the built-in console sink.                        |
| `logging.level`  | `"debug"` (console) / `"info"` (`onLog`) | Minimum severity emitted.                                                           |
| `logging.format` | `"english"`                              | Built-in console line format: `"english"` or `"json"`. Cannot be used with `onLog`. |

### Notable events

- `resolve_asset_base_url_fallback` (warn) -- a stored asset URL could not be parsed during origin override in passthrough mode.
- `dev_passthrough_ignores_sync_failure_mode` (warn) -- `devPassthrough` is true and `onSyncFailure` is not `"throw"`.
- `store_expired` (warn) -- the store declared `expiresAt` and the sync reached or passed it before download work completed.
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
  resolveStore: async () => store,
});
```

| Option               | Default               | Description                                                                      |
| -------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `maxCacheBytes`      | `undefined`           | Soft cap on total bytes of cached asset files.                                   |
| `reserveFreeBytes`   | 1 GiB (`1024³` bytes) | Minimum free disk space to preserve on the cache volume. Set **`0`** to disable. |
| `staleDeleteAfterMs` | 7 days                | Grace period before assets removed from the store are deleted from disk.         |

When limits are exceeded, the sync raises `StorageLimitError`. The configured `onSyncFailure` mode then applies.

Omitting `reserveFreeBytes` still enforces a **1 GiB** cushion for the OS and other apps on the same volume. Stores that barely fit on a full disk may need a larger disk, a lower explicit `reserveFreeBytes`, or **`reserveFreeBytes: 0`** to restore the old "no reservation" behavior.

Assets removed from the store are not deleted immediately. They are marked for grace-period deletion and pruned after `staleDeleteAfterMs` expires.

## API reference

### `@rockhall/electron-offline-content/main`

#### `createMediaStore(options?)`

Creates a `MediaStore` instance for populating in a `resolveStore` callback.

**`MediaStoreOptions`**

| Option        | Type     | Required | Description                                                       |
| ------------- | -------- | -------- | ----------------------------------------------------------------- |
| `snapshotId`  | `string` | no       | Opaque id for correlation, debugging, or multi-source merges.     |
| `retrievedAt` | `string` | no       | ISO 8601 timestamp describing when the store payload was built.   |
| `expiresAt`   | `string` | no       | ISO 8601 timestamp after which asset URLs are treated as expired. |

#### `MediaStore`

Returned by `createMediaStore`. Build the store imperatively by defining indexes and adding assets.

| Method                        | Returns            | Description                                                                                                                  |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `defineIndex(name, options?)` | `MediaIndex`       | Register a secondary index. Returns a callable handle. Options: `{ cardinality?: "single" \| "multi", required?: boolean }`. |
| `add(key, input)`             | `void`             | Add an asset. `key` is `AssetKeyInput` (`string` or `readonly string[]`); `input` is a `MediaAssetInput`.                    |
| `_serialize()`                | `AuthoredManifest` | Internal: serializes the authored store for manifest normalization. Not part of the public consumer API.                     |

**`MediaAssetInput`**

| Field        | Type                        | Required | Description                                                                                                                                                    |
| ------------ | --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`    | `string`                    | yes      | Bump triggers re-download.                                                                                                                                     |
| `mimeType`   | `string`                    | yes      | Valid `type/subtype` MIME type.                                                                                                                                |
| `fileName`   | `string`                    | no       | Override for the filename; derived from the URL when omitted.                                                                                                  |
| `byteLength` | `number`                    | no       | Expected file size in bytes; used for storage limit pre-checks.                                                                                                |
| `url`        | `string`                    | yes      | `http` or `https` download URL (use presigned URLs when auth is required). There is no `source` wrapper and no `MediaRemoteSource` type—only this flat string. |
| `metadata`   | `Record<string, JsonValue>` | no       | Arbitrary key-value metadata returned on resolved assets.                                                                                                      |
| `indexes`    | `IndexTag[]`                | no       | Tags from calling each `defineIndex` handle with a value (string or `string[]` for multi indexes).                                                             |

#### `MediaIndex`

Callable function type (interface) returned by `MediaStore.defineIndex`. Invoking it with a value produces an `IndexTag`. The handle also exposes read-only `indexName`, `cardinality`, and `required`.

```ts
const gallery = store.defineIndex("gallery");
store.add(["photos", "photo-1"], {
  version: "v1",
  mimeType: "image/jpeg",
  url: "https://cdn.example.com/photo-1.jpg",
  indexes: [gallery("nature")],
});
console.log(gallery.indexName); // "gallery"
```

#### `IndexTag`

Class whose instances are produced by calling a `MediaIndex` handle. Used as elements of `MediaAssetInput.indexes`. Exported from `@rockhall/electron-offline-content/main`.

#### `AssetKeyInput`

Type alias: `string | readonly string[]`. Used for `MediaStore.add` and `getAsset`. Arrays are joined with `/` for `displayKey` and hashed for stable `key` identity.

#### `mediaKindFromMime(mimeType)`

Derives a coarse `MediaKind` from a MIME type string:

| Input pattern        | Result       |
| -------------------- | ------------ |
| `video/*`            | `"video"`    |
| `image/*`            | `"image"`    |
| `audio/*`            | `"audio"`    |
| `text/html`          | `"html"`     |
| `text/*`             | `"text"`     |
| Known document types | `"document"` |
| `application/json`   | `"text"`     |
| Everything else      | `"binary"`   |

#### `createMediaCache(options)`

Creates a `MediaCacheMain` instance. Call before `app.whenReady()` in offline mode.

**`MediaCacheOptions`**

| Option                | Type                       | Required | Description                                                                                     |
| --------------------- | -------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `storagePath`         | `MediaCacheStoragePath`    | yes      | `{ appPath, segments? }` -- resolved via `app.getPath(appPath)` plus optional subpath segments. |
| `resolveStore`        | callback                   | yes      | Returns `MediaStore` or a `Promise<MediaStore>` for each sync.                                  |
| `devPassthrough`      | `boolean`                  | no       | Skip downloads, return remote URLs. Auto-enabled when `NODE_ENV === "development"`.             |
| `assetBaseUrl`        | `string`                   | no       | Origin override for dev passthrough (origin only, no path/query/hash).                          |
| `onSyncFailure`       | `SyncFailureMode`          | no       | Behavior when a sync fails after a prior snapshot exists (`serve-last-snapshot` or `throw`).    |
| `maxCacheBytes`       | `number`                   | no       | Soft cap on total cached bytes.                                                                 |
| `reserveFreeBytes`    | `number`                   | no       | Minimum free disk bytes to preserve. Default **1 GiB**; **`0`** disables.                       |
| `staleDeleteAfterMs`  | `number`                   | no       | Grace period (ms) before pruning removed assets. Default 7 days.                                |
| `downloadConcurrency` | `number`                   | no       | Assets downloaded in parallel during sync. Default 2; minimum 1.                                |
| `syncHistoryLimit`    | `number`                   | no       | Max completed sync runs retained in SQLite. Default 50.                                         |
| `logging`             | `MediaCacheLoggingOptions` | no       | Nested logging config for either a custom sink or built-in console formatting.                  |

#### `MediaCacheMain`

Returned by `createMediaCache`. Requires exclusive ownership of its resolved storage root.

| Method                                       | Returns                                         | Description                                                       |
| -------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `start()`                                    | `Promise<void>`                                 | One-call setup: register protocol, attach IPC, run initial sync.  |
| `syncNow()`                                  | `Promise<void>`                                 | Run or join a sync. Concurrent callers share one run.             |
| `getStatus()`                                | `Promise<MediaCacheStatus>`                     | Current phase, progress, last run, and error.                     |
| `getAsset(key)`                              | `Promise<ResolvedMediaAsset \| null>`           | Single asset by `AssetKeyInput`, or `null` if missing.            |
| `listByIndex(indexName, value, pagination?)` | `Promise<PaginationResult<ResolvedMediaAsset>>` | Assets matching a secondary index value, paginated.               |
| `findByFileStem(stem, pagination?)`          | `Promise<PaginationResult<FileStemMatch>>`      | Search by normalized filename stem.                               |
| `registerProtocol(options?)`                 | `Promise<void>`                                 | Register the `media:` handler on a session.                       |
| `attachIpc(options?)`                        | `Promise<void>`                                 | Wire `ipcMain` handlers and broadcast status to renderer windows. |

In kiosk-style apps, call `app.requestSingleInstanceLock()` before constructing the cache. The package enforces storage-root exclusivity itself, but the instance lock prevents a second Electron process from launching.

On the same host, the package reclaims a stale storage lock when the recorded PID no longer
exists or the operating system reports that the PID now belongs to a newer process instance. If
process identity cannot be inspected, ownership remains conservative and the lock is preserved.

#### Key types

**ResolvedMediaAsset** -- `{ key, displayKey, version, mimeType, kind: MediaKind, byteLength?, url, metadata: Record<string, JsonValue>, indexes: Record<string, string | string[]> }`. `key` is the stable storage hash; `displayKey` is the original human-readable key (string or segment path joined with `/`). `kind` is derived from `mimeType` via `mediaKindFromMime()`. `url` is a `media://asset/{encodedKey}` URL in offline mode or a remote URL in passthrough mode.

**FileStemMatch** -- `{ asset: ResolvedMediaAsset }`

**MediaKind** -- `"video" | "image" | "audio" | "document" | "html" | "text" | "binary"`

**MediaCacheStatus** -- `{ phase, storageRoot, activeGenerationId, progress, lastRun, error, updatedAt }`. `phase` is `"idle" | "syncing" | "ready" | "error"`.

**PaginationInput** -- `{ limit?, cursor? }`

**PaginationResult\<T\>** -- `{ items: T[], nextCursor: string | null }`

See the published `.d.ts` files for full type definitions.

### `@rockhall/electron-offline-content/preload`

#### `exposeMediaCacheBridge(options?)`

Calls `contextBridge.exposeInMainWorld` to put the `MediaCacheBridge` on `window.mediaCache` (or a custom key via `options.key`). Returns the bridge instance.

#### `createMediaCacheBridge()`

Builds a `MediaCacheBridge` without calling `contextBridge`. Use this if you manage `contextBridge` yourself.

### `@rockhall/electron-offline-content/renderer`

Framework-agnostic renderer client for apps using any UI framework, router loader, state manager, or plain DOM rendering. This is the recommended renderer integration for most consumers.

#### `createMediaCacheRenderer(options?)`

Resolves the preload bridge, subscribes to cache status, and creates async query watchers for app-owned renderer lifecycles.

Options:

| Option      | Type               | Description                                                                                       |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `bridge`    | `MediaCacheBridge` | Explicit bridge instance. When omitted, the client reads from `window.mediaCache` by default.     |
| `windowKey` | `string`           | Custom window key to read when your preload exposed the bridge somewhere other than `mediaCache`. |

```ts
import { createMediaCacheRenderer } from "@rockhall/electron-offline-content/renderer";

const renderer = createMediaCacheRenderer();
```

#### `MediaCacheRenderer`

Returned by `createMediaCacheRenderer()`.

| Member                                                   | Returns            | Description                                                              |
| -------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `bridge`                                                 | `MediaCacheBridge` | Direct access to renderer-safe async methods such as `getAsset()`.       |
| `subscribeCacheStatus(listener)`                         | `() => void`       | Subscribe to `MediaAsyncState<MediaCacheStatus>` snapshots.              |
| `watchMediaAsset(key, options, listener)`                | `() => void`       | Watch a single asset query.                                              |
| `watchMediaByIndex(indexName, value, options, listener)` | `() => void`       | Watch a secondary-index query.                                           |
| `watchFileStemMatch(stem, options, listener)`            | `() => void`       | Watch a file-stem search query.                                          |
| `dispose()`                                              | `void`             | Dispose status subscription and all active query watchers owned by this. |

Watcher listeners receive `MediaAsyncState<T>` snapshots:

```ts
{
  data: T | null; // latest resolved value
  loading: boolean; // true during initial load or refresh
  error: Error | null; // last request error
  refresh: () => Promise<void>;
}
```

Each `watch*` method returns an unsubscribe function. Call it when your host framework, route, or component no longer needs that query. Call `renderer.dispose()` when the renderer client itself is no longer needed.

Query watchers refetch after a completed sync by default. Pass `{ refetchOnSyncComplete: false }` to `watchMediaAsset`, `watchMediaByIndex`, or `watchFileStemMatch` to opt out. Index and file-stem watchers also accept `{ limit?, cursor? }`.

#### Renderer helpers

- `deriveMediaCachePhase(statusState)` returns `"loading"` before the first status snapshot, otherwise the cache status phase.
- `mediaCacheReadyFromStatus(status)` maps a `MediaCacheStatus | null` to `{ ready, syncing, phase, activeGenerationId, syncError }`.
- `aggregateMediaCacheErrors(statusState, queryErrors)` returns `{ syncError, statusError, queryErrors, hasError, primaryError }`.

## Notes

- v1 requires consumers to own cache busting through asset versions.
- v1 treats every asset as required for snapshot commit.
- Storage root exclusivity: `MediaCache` acquires exclusive ownership of its `storageRoot`. If `start()` fails after ownership is established, reuse the same instance or restart the process rather than constructing a replacement cache for the same root.

## Example apps

Two example apps demonstrate end-to-end wiring. Each is a standalone Electron Forge + React + Vite project.

- [examples/local/](examples/local/) -- uses a loopback HTTP server with small local fixtures. Also used by `pack:verify` on CI pushes to `main`.
- [examples/nasa/](examples/nasa/) -- uses public NASA SVS URLs for heavier manual demos (not run in CI).

Both examples exercise sync status, index-based listing, single-asset lookup, file-stem search, and rendering images and video from `media://` URLs (offline mode) or direct remote URLs (dev passthrough).

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the examples locally.
