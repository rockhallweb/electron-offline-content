---
name: cache-configuration
description: >
  createMediaCache options and targeted modifications: storagePath with
  appPath and segments, devPassthrough mode, assetBaseUrl origin override,
  onSyncFailure mode selection (serve-last-snapshot vs throw),
  maxCacheBytes, reserveFreeBytes, staleDeleteAfterMs, syncHistoryLimit,
  onLog structured logging with custom sinks (pino, logtape), logLevel,
  logFormat, MediaCacheLogEvent structure.
type: core
library: electron-offline-content
library_version: "0.1.1"
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
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";
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
  logLevel: "info",
  onLog: (entry) => {
    logger[entry.level === "debug" ? "debug" : entry.level](entry, entry.event);
  },
  resolveManifest: async () => {
    const res = await fetch("https://cms.example.com/api/content");
    return res.json();
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
  resolveManifest: async () => manifest,
});
```

This resolves to `<userData>/my-app/offline-media/` on disk. Each segment becomes a directory level — never include path separators inside a segment string.

### Dev passthrough mode

`devPassthrough` skips downloads entirely and serves remote URLs directly. It defaults to `true` when `NODE_ENV === "development"` and `false` otherwise. Set it explicitly for clarity:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: true,
  resolveManifest: async () => manifest,
});
```

When `devPassthrough` is `true`:

- `resolveAssetRequest` is never called — assets load from their original remote URLs.
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
  resolveManifest: async () => manifest,
});
```

- `maxCacheBytes` — soft cap on total cache size in bytes. The sync pipeline skips new downloads when the cache exceeds this limit.
- `reserveFreeBytes` — minimum free disk space to preserve. Downloads pause when free space drops below this threshold.
- `staleDeleteAfterMs` — how long removed assets (no longer in the manifest) stay on disk before deletion. Defaults to keeping stale assets indefinitely when unset.

### Structured logging

`onLog` receives `MediaCacheLogEvent` objects with structured fields (`timestamp`, `level`, `event`, `service`, `component`, plus context-specific keys). Pipe them to any structured logger:

**pino:**

```typescript
import pino from "pino";

const logger = pino({ name: "media-cache" });

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  logLevel: "info",
  onLog: (entry) => {
    logger[entry.level === "debug" ? "debug" : entry.level](entry, entry.event);
  },
  resolveManifest: async () => manifest,
});
```

**logtape:**

```typescript
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["media-cache"]);

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  logLevel: "info",
  logFormat: "json",
  onLog: (entry) => {
    logger[entry.level](entry.event, entry);
  },
  resolveManifest: async () => manifest,
});
```

When `onLog` is omitted and `NODE_ENV !== "production"`, the package prints to `console`. Default `logLevel` is `"debug"` for the built-in console sink and `"info"` when a custom `onLog` is provided.

## Common Mistakes

### HIGH: Setting assetBaseUrl without devPassthrough

`assetBaseUrl` is only valid in dev passthrough mode. The constructor throws if `assetBaseUrl` is set while `devPassthrough` is `false` (or defaults to `false`).

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  assetBaseUrl: "http://localhost:3000",
  resolveManifest: async () => manifest,
});
```

Correct:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: true,
  assetBaseUrl: "http://localhost:3000",
  resolveManifest: async () => manifest,
});
```

Source: media-cache.ts constructor

### HIGH: Using arbitrary file paths for storagePath

`storagePath` requires an object with `appPath` (an Electron `app.getPath` name) and optional `segments`. Raw string paths are not accepted.

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: "/tmp/my-cache" as any,
  resolveManifest: async () => manifest,
});
```

Correct:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "temp", segments: ["my-app", "cache"] },
  resolveManifest: async () => manifest,
});
```

Source: types.ts; validation.ts

### HIGH: Two cache instances targeting same storage root

Wrong:

```typescript
const cacheA = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveManifest: async () => manifestA,
});
const cacheB = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveManifest: async () => manifestB,
});
```

Correct:

```typescript
const cacheA = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveManifest: async () => manifestA,
});
const cacheB = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media-b"] },
  resolveManifest: async () => manifestB,
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
  resolveManifest: async () => manifest,
});
```

Correct:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: true,
  assetBaseUrl: "http://localhost:3000",
  resolveManifest: async () => manifest,
});
```

Source: media-cache.ts normalizeAssetBaseUrl

### MEDIUM: Path separators in storagePath segments

Each entry in the `segments` array becomes a single directory name. Segments must not contain `"/"` or `"\\"` — use separate array entries instead.

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["my-app/offline-media"] },
  resolveManifest: async () => manifest,
});
```

Correct:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["my-app", "offline-media"] },
  resolveManifest: async () => manifest,
});
```

Source: validation.ts

### CRITICAL: devPassthrough left enabled in production (cross-skill: production-checklist)

In production Electron builds, `NODE_ENV` may be unset — which defaults `devPassthrough` to `false`. But if `NODE_ENV` is explicitly set to `"development"` in a deployed build, all downloads are silently skipped and the app serves only remote URLs. Set `devPassthrough: false` explicitly for production builds:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  resolveManifest: async () => manifest,
});
```

Source: media-cache.ts; types.ts
See also: production-checklist/SKILL.md § Common Mistakes

### HIGH: Expecting resolveAssetRequest to work in devPassthrough (cross-skill: authenticated-downloads)

Wrong:

```typescript
createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: true,
  resolveAssetRequest: async (ctx) => ({
    url: await getSignedUrl(ctx.asset.source.url),
  }),
  resolveManifest: async () => manifest,
});
```

Correct:

```typescript
createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  resolveAssetRequest: async (ctx) => ({
    url: await getSignedUrl(ctx.asset.source.url),
  }),
  resolveManifest: async () => manifest,
});
```

In dev passthrough mode, `resolveAssetRequest` is never called. Assets requiring auth will fail to load because the renderer fetches original remote URLs directly.

Source: README
See also: authenticated-downloads/SKILL.md § Common Mistakes

### HIGH Tension: Dev passthrough simplicity vs production correctness

`devPassthrough` makes development fast but changes behavior: `resolveAssetRequest` is ignored, `onSyncFailure` is overridden to `"throw"`, URLs are remote instead of `media://`. Code working in dev passthrough may break in production offline mode.

See also: production-checklist/SKILL.md § Common Mistakes

### HIGH Tension: Sync resilience vs stale content

`"serve-last-snapshot"` is safe for kiosks (never blank screen) but may serve outdated content indefinitely if syncs keep failing. `"throw"` is honest but can leave the UI empty.

See also: production-checklist/SKILL.md § Common Mistakes

---

See also: getting-started/SKILL.md — Initial createMediaCache setup
See also: production-checklist/SKILL.md — Go-live configuration audit
See also: authenticated-downloads/SKILL.md — resolveAssetRequest is ignored in devPassthrough

## References

- [Complete MediaCacheOptions reference](references/options.md)
