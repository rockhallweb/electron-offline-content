# Changelog

## 0.3.0

### Breaking changes

**React (`@rockhallweb/electron-offline-content/react`)**

- Replaced `useMediaItem`, `useMediaItems`, `useMediaNamespace`, and `useMediaNamespaceTree` with a single discriminated hook, `useMedia({ kind: "item", ... })` and `useMedia({ kind: "list", ... })`.
- Renamed `useMediaCacheBridge` to `useMediaBridge` (same bridge surface, plus shared `phase`, `status`, and aggregated `errors`).
- `useMediaCacheErrors()` no longer accepts hook results; it aggregates sync, status, and all active queries for the current `MediaCacheProvider`.
- `useMediaCacheStatus()` now exposes a top-level `phase` field (cache phase or `"loading"` before the first status snapshot).

**Main (`@rockhallweb/electron-offline-content/main`)**

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

- AI agent skill specifications in `skills/_artifacts/` — domain map, skill spec, and skill tree covering getting-started, manifest-authoring, cache-configuration, react-rendering, authenticated-downloads, and production-checklist workflows.
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
