---
name: cache-configuration
description: >
  createMediaCache options and targeted modifications: storagePath with
  appPath and segments, devPassthrough mode, assetBaseUrl origin override,
  onSyncFailure mode selection (serve-last-snapshot vs throw),
  maxCacheBytes, reserveFreeBytes, staleDeleteAfterMs, syncHistoryLimit,
  nested logging config with custom sinks (pino, logtape), log levels,
  console formats, and MediaCacheLogEvent structure.
type: core
library: electron-offline-content
library_version: "0.4.0"
requires:
  - getting-started
sources:
  - "rockhallweb/electron-offline-content:src/main/media-cache.ts"
  - "rockhallweb/electron-offline-content:src/shared/types.ts"
  - "rockhallweb/electron-offline-content:src/internal/validation.ts"
  - "rockhallweb/electron-offline-content:src/main/storage-root-lock.ts"
---

# Cache Configuration

This skill builds on getting-started. Read it first for full main → preload → renderer wiring.

## Setup

```typescript
import { app } from "electron";
import { createMediaCache, createMediaStore } from "@rockhallweb/electron-offline-content/main";
import pino from "pino";

const logger = pino({ name: "media-cache" });

if (!app.requestSingleInstanceLock()) {
  app.exit(1);
}

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  onSyncFailure: "serve-last-snapshot",
  maxCacheBytes: 10 * 1024 * 1024 * 1024,
  reserveFreeBytes: 1 * 1024 * 1024 * 1024,
  logging: {
    level: "info",
    onLog: (entry) => {
      logger[entry.level === "debug" ? "debug" : entry.level](entry, entry.event);
    },
  },
  resolveStore: async () => {
    const res = await fetch("https://cms.example.com/api/content");
    const data = await res.json();
    const store = createMediaStore();
    for (const item of data.items) {
      store.add(item.id, {
        version: item.updatedAt,
        mimeType: item.mimeType,
        source: { url: item.url },
        metadata: item.metadata,
      });
    }
    return store;
  },
});
```

## Core Patterns

### Storage path configuration

`storagePath` maps to Electron's `app.getPath()` names. The `appPath` field accepts any `MediaCacheAppPath` value (`"userData"`, `"temp"`, `"documents"`, etc.). Use the `segments` array to add subdirectories — the package joins them with the platform path separator.

```typescript
const mediaCache = createMediaCache({
  storagePath: {
    appPath: "userData",
    segments: ["my-app", "offline-media"],
  },
  resolveStore: async () => store,
});
```

This resolves to `<userData>/my-app/offline-media/` on disk. Each segment becomes a directory level — never include path separators inside a segment string.

### Dev passthrough mode

`devPassthrough` skips downloads entirely and serves remote URLs directly. It defaults to `true` when `NODE_ENV === "development"` and `false` otherwise. Set it explicitly for clarity:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: true,
  resolveStore: async () => store,
});
```

When `devPassthrough` is `true`:

- Downloads are skipped — assets load from their original remote URLs.
- `onSyncFailure` is overridden to `"throw"` — there is no snapshot to serve.
- Hook URLs return remote `https://` URLs instead of `media://` URLs.
- `assetBaseUrl` becomes available for origin overrides.

### Storage limits

Three options control disk usage:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  maxCacheBytes: 10 * 1024 * 1024 * 1024,
  reserveFreeBytes: 1 * 1024 * 1024 * 1024,
  staleDeleteAfterMs: 7 * 24 * 60 * 60 * 1000,
  resolveStore: async () => store,
});
```

- `maxCacheBytes` — soft cap on total cache size in bytes. The sync pipeline skips new downloads when the cache exceeds this limit.
- `reserveFreeBytes` — minimum free disk space to preserve on the cache volume (default **1 GiB** when omitted; **`0`** disables). Still recommended to set an explicit value on kiosk hardware to match SSD capacity and OS needs.
- `staleDeleteAfterMs` — how long removed assets (no longer in the store) stay on disk before deletion. Defaults to 7 days (604,800,000 ms) when unset.

### Structured logging

Use the nested `logging` object for all log configuration. `logging.onLog` receives `MediaCacheLogEvent` objects with structured fields (`timestamp`, `level`, `event`, `service`, `component`, plus context-specific keys). Pipe them to any structured logger:

**pino:**

```typescript
import pino from "pino";

const logger = pino({ name: "media-cache" });

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  logging: {
    level: "info",
    onLog: (entry) => {
      logger[entry.level === "debug" ? "debug" : entry.level](entry, entry.event);
    },
  },
  resolveStore: async () => store,
});
```

**logtape:**

```typescript
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["media-cache"]);

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  logging: {
    level: "info",
    onLog: (entry) => {
      logger[entry.level](entry.event, entry);
    },
  },
  resolveStore: async () => store,
});
```

When `logging.onLog` is omitted and `NODE_ENV !== "production"`, the package prints to `console`. Default `logging.level` is `"debug"` for the built-in console sink and `"info"` when a custom `logging.onLog` is provided.

Use `logging.format` only with the built-in console sink:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  logging: {
    level: "debug",
    format: "json",
  },
  resolveStore: async () => store,
});
```

Breaking migration:

- Old flat options `onLog`, `logLevel`, and `logFormat` were removed in `0.2.0`.
- Move them under `logging`.
- Do not combine `logging.format` with `logging.onLog`; custom sinks already receive structured events.

## Common Mistakes

### HIGH: Setting assetBaseUrl without devPassthrough

`assetBaseUrl` is only valid in dev passthrough mode. The constructor throws if `assetBaseUrl` is set while `devPassthrough` is `false` (or defaults to `false`).

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  assetBaseUrl: "http://localhost:3000",
  resolveStore: async () => store,
});
```

Correct:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: true,
  assetBaseUrl: "http://localhost:3000",
  resolveStore: async () => store,
});
```

Source: media-cache.ts constructor

### HIGH: Using arbitrary file paths for storagePath

`storagePath` requires an object with `appPath` (an Electron `app.getPath` name) and optional `segments`. Raw string paths are not accepted.

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: "/tmp/my-cache" as any,
  resolveStore: async () => store,
});
```

Correct:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app", "cache"] },
  resolveStore: async () => store,
});
```

Source: types.ts; validation.ts

### HIGH: Two cache instances targeting same storage root

Wrong:

```typescript
const cacheA = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveStore: async () => storeA,
});
const cacheB = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveStore: async () => storeB,
});
```

Correct:

```typescript
const cacheA = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveStore: async () => storeA,
});
const cacheB = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media-b"] },
  resolveStore: async () => storeB,
});
```

`MediaCache` acquires exclusive ownership of its storage directory via a lock file. A second instance targeting the same path throws `StorageOwnershipError`. Use `app.requestSingleInstanceLock()` to prevent duplicate processes.

Source: storage-root-lock.ts

### MEDIUM: assetBaseUrl with path or query string

`assetBaseUrl` must be an origin only — protocol, hostname, and optional port. Including a path, query string, hash, or credentials causes the constructor to throw.

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: true,
  assetBaseUrl: "http://localhost:3000/api/assets?v=2",
  resolveStore: async () => store,
});
```

Correct:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: true,
  assetBaseUrl: "http://localhost:3000",
  resolveStore: async () => store,
});
```

Source: media-cache.ts normalizeAssetBaseUrl

### MEDIUM: Path separators in storagePath segments

Each entry in the `segments` array becomes a single directory name. Segments must not contain `"/"` or `"\\"` — use separate array entries instead.

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["my-app/offline-media"] },
  resolveStore: async () => store,
});
```

Correct:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["my-app", "offline-media"] },
  resolveStore: async () => store,
});
```

Source: validation.ts

### CRITICAL: devPassthrough left enabled in production (cross-skill: production-checklist)

In production Electron builds, `NODE_ENV` may be unset — which defaults `devPassthrough` to `false`. But if `NODE_ENV` is explicitly set to `"development"` in a deployed build, all downloads are silently skipped and the app serves only remote URLs. Set `devPassthrough: false` explicitly for production builds:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  resolveStore: async () => store,
});
```

Source: media-cache.ts; types.ts
See also: production-checklist/SKILL.md § Common Mistakes

### HIGH Tension: Dev passthrough simplicity vs production correctness

`devPassthrough` makes development fast but changes behavior: downloads are skipped, `onSyncFailure` is overridden to `"throw"`, URLs are remote instead of `media://`. Code working in dev passthrough may break in production offline mode.

See also: production-checklist/SKILL.md § Common Mistakes

### HIGH Tension: Sync resilience vs stale content

`"serve-last-snapshot"` is safe for kiosks (never blank screen) but may serve outdated content indefinitely if syncs keep failing. `"throw"` is honest but can leave the UI empty.

See also: production-checklist/SKILL.md § Common Mistakes

---

See also: getting-started/SKILL.md — Initial createMediaCache setup
See also: production-checklist/SKILL.md — Go-live configuration audit
See also: authenticated-downloads/SKILL.md — Auth embedded in resolveStore

## References

- [Complete MediaCacheOptions reference](references/options.md)
