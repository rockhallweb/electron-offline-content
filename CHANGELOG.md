# Changelog

## 0.6.0

### Added

- `downloadConcurrency` option (`MediaCacheOptions`) downloads assets in parallel during sync via a small worker pool, filling the throughput valleys left by the previous one-at-a-time loop. Defaults to `2`, clamped to a minimum of `1` and capped at the number of queued downloads. Failure semantics are unchanged: on the first error, workers stop dequeuing new assets, in-flight downloads run to completion (leaving resumable `.part` files), and the first error propagates through the existing rollback path. (#94)

### Fixed

- A failed sync no longer deletes the completed downloads it staged. Rolling back a failed or orphaned staged generation now removes only its database rows; fully downloaded blobs stay on disk, and the sync diff adopts an existing complete blob at `blobs/<assetKey>/<version>/<fileName>` regardless of which generation downloaded it. Large initial syncs on unreliable connections now make forward progress across failures and restarts instead of restarting from zero.
- Each sync now sweeps blobs that nothing references (no active generation row, no pending deletion, not expected by the incoming manifest), so never-committed leftovers from failed syncs cannot accumulate or wedge `maxCacheBytes` enforcement.

## 0.5.0

### Security

- Manifest-provided path segments can no longer escape the storage root: dot-only segments (`.`/`..`) are percent-encoded before building blob paths, and blob destinations are validated for storage-root containment before any filesystem write or delete. Fixes #89. (#90)

### Changed

- Write-side file stems are now normalized with the shared read-side rule (lowercased basename), so `findByFileStem` matching is consistent regardless of manifest casing. (#84)
- `MediaStore._serialize()` (internal) now returns an authoring-only `AuthoredManifest`; derived fields (media kind, built-in indexes, stem) are produced by `normalizeManifest()` during generation staging. (#84)

### Added

- New exported types: `AuthoredManifest`, `AuthoredManifestAsset`. (#84)

### Internal

- Resolved catalog projection separated from SQLite storage: `MediaCacheDatabase` returns validated rows; `ResolvedMediaAsset` projection and URL policy now live in a dedicated projection module. (#82)
- `media:` protocol serving extracted behind a main-process adapter (`registerMediaProtocolHandler`) with comprehensive range-request tests. (#80)
- Storage budget checks (max cache size, reserved free bytes) extracted from Asset Download and MediaCache orchestration into a `StorageBudget` module. (#83)
- Example apps: dev-dependency updates (esbuild, vite). (#87)

## 0.4.0

### Breaking changes

**Store API (replaces Manifest API)**

- `defineManifest()`, `defineItem()`, `defineAsset()` removed. Replaced by `createMediaStore()`, `store.defineIndex()`, `store.add()`.
- `namespacesFromEntries()`, `itemsFromEntries()`, `assetsFromEntries()` removed.
- `resolveManifest` option replaced by `resolveStore` (returns a `MediaStore` or `Promise<MediaStore>`).
- `resolveAssetRequest` option removed entirely; embed presigned (or otherwise auth-bearing) URLs in each asset’s flat `url` field during `resolveStore()`.
- **`source: { url, method?, headers? }` → flat `url: string`:** The nested `source` object is removed. `MediaAssetInput` and `FlatManifestAsset` require a top-level **`url: string`**. **`MediaRemoteSource` is removed.** Use `store.add(key, { url: "https://..." })` instead of `store.add(key, { source: { url: "https://..." } })`. Custom HTTP methods and per-request headers are not supported; use presigned URLs (or URLs that encode credentials in the query string).
- Hierarchical `namespace/item/asset` model replaced by flat `assetKey` model with user-defined secondary indexes.
- Per-asset versioning: each asset has its own `version` string (no longer inherited from parent item).
- Asset keys are hashed for storage identity (SHA-256, first 16 hex characters). `store.add()`, `getAsset()`, and `useMediaAsset()` accept `string | readonly string[]` (the `AssetKeyInput` type). There is no validation of key characters or shape beyond non-empty strings or non-empty string segments.
- `ResolvedMediaAsset.key` is the stable hash; the original human-readable key is available as `displayKey`.

**Error renames:**

- `ManifestValidationError` → `StoreValidationError` (code: `STORE_VALIDATION_ERROR`)
- `ManifestExpiredError` → `StoreExpiredError` (code: `STORE_EXPIRED`)

**Main process API:**

- `getItem(namespace, id)` → `getAsset(key)`
- `listNamespace(namespace, pagination?)` → `listByIndex(indexName, value, pagination?)`
- `listNamespaceTree(prefix, pagination?)` → removed (use indexes instead)

**React hooks:**

- `useMedia({ kind: "item", ... })` and `useMedia({ kind: "list", ... })` → removed
- New hooks: `useMediaAsset(key)`, `useMediaByIndex(indexName, value, options?)`
- `useFileStemMatch` no longer accepts a `namespace` option

**Types:**

- Removed: `MediaCacheManifest`, `MediaNamespaceValue`, `MediaItemValue`, `MediaAssetValue`, `ResolvedMediaContentItem`, `MediaRemoteSource`
- New: `MediaAssetInput`, `FlatManifest`, `FlatManifestAsset`, `IndexDefinition`
- `ResolvedMediaAsset` now has: `key` (hash), `displayKey` (original key), `version`, `kind: MediaKind`, `mimeType`, `indexes: Record<string, string>`, `metadata: Record<string, unknown>`
- `FileStemMatch` now has `asset: ResolvedMediaAsset` instead of `item: ResolvedMediaContentItem`
- `SyncProgress.phase` includes `"resolving-store"` instead of `"resolving-manifest"`

**New exports:**

- `createMediaStore`, `MediaStore`, `MediaIndex`, `mediaKindFromMime`
- Types: `AssetKeyInput`, `IndexTag`

**Protocol URL:**

- Old: `media://{namespace}/{itemId}/{assetId}`
- New: `media://asset/{encodedAssetKey}`

**IPC channels:**

- `getItem`, `listNamespace`, `listNamespaceTree` → `getAsset`, `listByIndex`

### Migration

**Store creation**

```ts
// Before — hierarchical manifest with defineManifest / defineItem / defineAsset
import {
  defineAsset,
  defineItem,
  defineManifest,
  itemsFromEntries,
} from "@rockhall/electron-offline-content/main";

const manifest = defineManifest({
  namespaces: {
    videos: {
      items: itemsFromEntries(data.videos, (v) => [
        v.slug,
        defineItem({
          version: v.updatedAt,
          kind: "video",
          assets: {
            main: defineAsset({
              role: "primary",
              kind: "video",
              source: { url: v.videoUrl },
            }),
          },
        }),
      ]),
    },
  },
});

// After — flat store with createMediaStore / defineIndex / store.add
import { createMediaStore } from "@rockhall/electron-offline-content/main";

const store = createMediaStore();
const category = store.defineIndex("category");

for (const v of data.videos) {
  store.add(["video", v.slug], {
    version: v.updatedAt,
    mimeType: "video/mp4",
    url: v.videoUrl,
    metadata: { title: v.title, category: "videos" },
    indexes: [category("videos")],
  });
}
```

**Main process wiring**

```ts
// Before
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveManifest: async () => {
    const res = await fetch("https://cms.example.com/api/content");
    return res.json();
  },
});

// After
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveStore: async () => {
    const res = await fetch("https://cms.example.com/api/content");
    const data = await res.json();
    const store = createMediaStore();
    const category = store.defineIndex("category");
    for (const item of data.items) {
      store.add(["items", item.id], {
        version: item.updatedAt,
        mimeType: item.mimeType,
        url: item.url,
        metadata: item.metadata,
        indexes: [category("catalog")],
      });
    }
    return store;
  },
});
```

**React hooks**

```tsx
// Before — useMedia with kind discriminator
const item = useMedia({ kind: "item", namespace: "videos", id: "welcome" });
const list = useMedia({ kind: "list", namespace: "videos", limit: 20 });
// item.data.assetsByRole.primary?.url
// list.data.items.map(...)

// After — useMediaAsset / useMediaByIndex (key may be a string or string[]; must match resolveStore)
const asset = useMediaAsset(["video", "welcome"]);
const videos = useMediaByIndex("category", "videos", { limit: 20 });
// asset.data?.url
// videos.data?.items.map(...)
```

**Auth (resolveAssetRequest → presigned `url` in resolveStore)**

```ts
// Before — resolveAssetRequest callback signed each download
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveAssetRequest: async (ctx) => ({
    url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: "b", Key: ctx.asset.source.url }), {
      expiresIn: 3600,
    }),
  }),
  resolveManifest: async () => fetchManifest(),
});

// After — embed signed URLs in each asset’s flat url during resolveStore()
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveStore: async () => {
    const store = createMediaStore();
    for (const item of await fetchCatalog()) {
      const signedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: "b", Key: item.key }),
        { expiresIn: 3600 },
      );
      store.add(["assets", item.id], {
        version: item.revision,
        mimeType: "video/mp4",
        url: signedUrl,
      });
    }
    return store;
  },
});
```

## 0.3.0

### Breaking changes

**React (`@rockhall/electron-offline-content/react`)**

- Replaced `useMediaItem`, `useMediaItems`, `useMediaNamespace`, and `useMediaNamespaceTree` with a single discriminated hook, `useMedia({ kind: "item", ... })` and `useMedia({ kind: "list", ... })`.
- Renamed `useMediaCacheBridge` to `useMediaBridge` (same bridge surface, plus shared `phase`, `status`, and aggregated `errors`).
- `useMediaCacheErrors()` no longer accepts hook results; it aggregates sync, status, and all active queries for the current `MediaCacheProvider`.
- `useMediaCacheStatus()` now exposes a top-level `phase` field (cache phase or `"loading"` before the first status snapshot).

**Main (`@rockhall/electron-offline-content/main`)**

- Manifest authoring uses `Record`-keyed maps: `namespaces`, per-namespace `items`, and per-item `assets` are keyed by stable id strings; item and asset values no longer carry redundant `id` fields.
- Renamed `defineManifestItem` → `defineItem` and `defineManifestAsset` → `defineAsset`.
- Added `namespacesFromEntries`, `itemsFromEntries`, and `assetsFromEntries` to build those records from arrays with validation and duplicate-key checks.
- Public types follow the new value shapes (`MediaNamespaceValue`, `MediaItemValue`, `MediaAssetValue`, and related sync types). See published `.d.ts` files for the full surface.

### Migration

**React**

```tsx
// Item lookup
// Before
const item = useMediaItem("space", "hubble-cosmos");

// After
const item = useMedia({ kind: "item", namespace: "space", id: "hubble-cosmos" });
```

```tsx
// Namespace list or tree
// Before
const flat = useMediaItems("videos", { limit: 20 });
const tree = useMediaItems("courses", { recursive: true, limit: 40 });
// or (deprecated)
const flat = useMediaNamespace("videos", { limit: 20 });
const tree = useMediaNamespaceTree("courses", { limit: 40 });

// After
const flat = useMedia({ kind: "list", namespace: "videos", limit: 20 });
const tree = useMedia({
  kind: "list",
  namespace: "courses",
  recursive: true,
  limit: 40,
});
```

```tsx
// Bridge + errors
// Before
const bridge = useMediaCacheBridge();
const errors = useMediaCacheErrors(status, item, list);

// After (errors on the bridge match `useMediaCacheErrors()`)
const { syncNow, phase, errors } = useMediaBridge();
```

**Manifest**

```ts
// Before (array-shaped namespaces / items / assets with inline ids)
defineManifest({
  namespaces: [
    {
      key: "videos",
      items: [
        {
          id: "clip-1",
          version: "1",
          kind: "video",
          assets: [{ id: "main", role: "primary", kind: "video", source: { url } }],
        },
      ],
    },
  ],
});

// After (records keyed by id)
defineManifest({
  namespaces: {
    videos: {
      items: {
        "clip-1": defineItem({
          version: "1",
          kind: "video",
          assets: {
            main: defineAsset({ role: "primary", kind: "video", source: { url } }),
          },
        }),
      },
    },
  },
});
```

Prefer `itemsFromEntries` / `assetsFromEntries` / `namespacesFromEntries` when building from CMS or API arrays (see README).

### Changed

- **`reserveFreeBytes` default:** When the option is omitted, offline sync now preserves **1 GiB** (`1024³` bytes) of free space on the cache volume instead of treating the reserve as zero. Set **`reserveFreeBytes: 0`** to restore the previous behavior.

## 0.2.0

### Changed

- Breaking: removed the flat `onLog`, `logLevel`, and `logFormat` `MediaCacheOptions` fields in favor of a nested `logging` object.
- `logging` is now a discriminated configuration shape: use `logging.onLog` for a custom structured sink, or `logging.format` for the built-in console sink, but not both together.

### Migration

```ts
// Before
createMediaCache({
  logLevel: "info",
  onLog: (entry) => logger.info(entry, entry.event),
  resolveManifest,
});

// After
createMediaCache({
  logging: {
    level: "info",
    onLog: (entry) => logger.info(entry, entry.event),
  },
  resolveManifest,
});
```

```ts
// Before
createMediaCache({
  logLevel: "debug",
  logFormat: "json",
  resolveManifest,
});

// After
createMediaCache({
  logging: {
    level: "debug",
    format: "json",
  },
  resolveManifest,
});
```

`logging.format` is only for the built-in console sink and cannot be used with `logging.onLog`.

## 0.1.3

### Added

- Manifest expiration support: optional `expiresAt` field causes sync to fail fast with `ManifestExpiredError` once pre-signed URLs are past their TTL.
- Cursor worktree helpers (`pnpm worktree:new`, `worktree:open`, `worktree:list`, `worktree:prune`) for package development workflows.

## 0.1.2

### Fixed

- Clean up orphaned staged generations during startup so interrupted syncs do not leave behind unused SQLite rows or blob files.

## 0.1.1

### Added

- AI agent skill specifications in `skills/_artifacts/` — domain map, skill spec, and skill tree covering getting-started, store-authoring, cache-configuration, react-rendering, authenticated-downloads, and production-checklist workflows.
- `@tanstack/intent` dev dependency for skill tooling.

### Changed

- Minor README formatting adjustments around markdown tables.

## 0.1.0

Initial release.

- Full-catalog manifest sync with SQLite metadata index.
- Disk-backed binary asset cache with atomic downloads.
- Privileged `media://` protocol for renderer-safe local URLs.
- Preload bridge and React hooks for renderer access.
- Dev passthrough mode for local development without downloading assets.
- Authenticated asset downloads via `resolveAssetRequest` or static source headers.
- Storage limits (`maxCacheBytes`, `reserveFreeBytes`, `staleDeleteAfterMs`).
- Structured logging with pluggable sinks.
- Sync failure resilience (`serve-last-snapshot` / `throw`).
- Namespace-based content organization with dot-delimited hierarchies.
- Two example apps (local fixtures, NASA SVS).
