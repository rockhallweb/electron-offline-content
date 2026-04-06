# Changelog

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
