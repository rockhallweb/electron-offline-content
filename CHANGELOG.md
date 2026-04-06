# Changelog

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
