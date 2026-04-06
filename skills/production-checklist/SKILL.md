---
name: production-checklist
description: >
  Go-live audit for kiosk deployment: verify devPassthrough disabled,
  storage limits set for device hardware (maxCacheBytes, reserveFreeBytes),
  structured logging wired to production sink, onSyncFailure mode chosen,
  app.requestSingleInstanceLock in place, scope boundaries confirmed
  (read-only presentation assets only), offline mode tested with real
  storage path and media:// protocol URLs, disk space validated for
  full catalog download.
type: lifecycle
library: electron-offline-content
library_version: "0.1.1"
requires:
  - cache-configuration
sources:
  - "rockhallweb/electron-offline-content:src/main/media-cache.ts"
  - "rockhallweb/electron-offline-content:src/shared/types.ts"
  - "rockhallweb/electron-offline-content:src/main/storage-root-lock.ts"
  - "rockhallweb/electron-offline-content:README.md"
---

# Production Checklist

This skill builds on cache-configuration. Read it first for all createMediaCache options.

## Runtime Configuration Checks

### Check: devPassthrough is explicitly disabled

**Expected:**

```typescript
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  resolveManifest: async () => manifest,
});
```

**Fail condition:** `NODE_ENV` is `"development"` in production build, or `devPassthrough` is omitted and `NODE_ENV` is not set. Defaults to `false` when `NODE_ENV` is unset, but being explicit prevents silent regressions if build tooling sets `NODE_ENV`.

**Fix:** Set `devPassthrough: false` explicitly in production configuration.

### Check: onSyncFailure mode is chosen deliberately

**Expected — kiosk that must always show content:**

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  onSyncFailure: "serve-last-snapshot",
  resolveManifest: async () => manifest,
});
```

**Expected — app that needs fresh content:**

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  onSyncFailure: "throw",
  resolveManifest: async () => manifest,
});
```

**Fail condition:** `onSyncFailure` omitted — default may not match your use case. Stale content on a kiosk loop may be acceptable; stale content on an info display with time-sensitive data may not.

**Fix:** Set explicitly based on whether stale content or a blank screen is worse for your deployment.

### Check: app.requestSingleInstanceLock() is in place

**Expected:**

```typescript
import { app } from "electron";
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";

if (!app.requestSingleInstanceLock()) {
  app.exit(1);
}

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  resolveManifest: async () => manifest,
});
```

**Fail condition:** Second process launches and collides on the storage root. `StorageOwnershipError` thrown at `start()` time — kiosk may silently restart into a crash loop.

**Fix:** Acquire lock before `createMediaCache`. Exit immediately on failure.

## Storage Checks

### Check: Storage limits are set for device hardware

**Expected:**

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  maxCacheBytes: 10 * 1024 * 1024 * 1024,
  reserveFreeBytes: 1 * 1024 * 1024 * 1024,
  resolveManifest: async () => manifest,
});
```

**Fail condition:** Cache consumes all disk on kiosk SSD. OS becomes unresponsive, other apps crash, kiosk requires physical intervention.

**Fix:** Set `maxCacheBytes` based on device SSD capacity. Set `reserveFreeBytes` to preserve space for OS, logs, and other apps. Example: 128 GB SSD kiosk → `maxCacheBytes: 80 * 1024 * 1024 * 1024`, `reserveFreeBytes: 5 * 1024 * 1024 * 1024`.

### Check: storagePath targets a valid writable location

**Expected:** `storagePath` uses an `appPath` that is writable on the target platform after packaging.

**Fail condition:** Permission errors at runtime on certain platforms or packagers. `"userData"` is generally safe; other paths may not be writable in sandboxed or locked-down kiosk environments.

**Fix:** Build and run the packaged app on the target platform. Verify the resolved storage directory is writable. Check with `app.getPath("userData")` in the main process to confirm the actual path.

## Logging Checks

### Check: Structured logging wired to production sink

**Expected:**

```typescript
import pino from "pino";
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";

const logger = pino({ name: "media-cache" });

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  logging: {
    level: "info",
    onLog: (entry) => {
      logger[entry.level === "debug" ? "debug" : entry.level](entry, entry.event);
    },
  },
  resolveManifest: async () => manifest,
});
```

**Fail condition:** Default console logging is invisible on headless kiosks. Sync failures, disk errors, and download issues go unnoticed until content goes stale.

**Fix:** Set `logging.onLog` with your production logger. Wire to pino, logtape, or your log aggregation service. Set `logging.level: "info"` — `"debug"` produces high volume in production.

## Scope Boundary Checks

### Check: Package used only for read-only presentation assets

**Expected:** Cache serves media for display — video, images, audio, documents. Content flows one direction: CMS → manifest → download → local storage → renderer display.

**Fail condition:** Package misused for user-generated content (webcam captures, user uploads, form attachments) or runtime data storage. No write operations are exposed to the renderer. The cache is read-only by design.

**Fix:** Use a different solution for user-generated content. Electron's `dialog.showSaveDialog`, IndexedDB, or a separate upload service are appropriate for user-created files.

## Testing Checks

### Check: Offline mode tested with real storage path and media:// URLs

**Expected:** App built and tested with `devPassthrough: false`. Content loads from `media://` protocol URLs. Renderer displays media correctly from local storage.

**Fail condition:**

- `storagePath` permissions fail on the target platform after packaging.
- DOM security policies block `media://` protocol URLs in `<video>`, `<img>`, or `<audio>` elements.
- Media rendering issues (codec support, file integrity) only surface when serving from disk.
- All of these are invisible in dev passthrough mode because assets load from remote `https://` URLs.

**Fix:** Build the production binary. Run it with `devPassthrough: false`. Navigate every content type. Verify `media://` URLs render in all media elements.

### Check: Full catalog download tested for disk space

**Expected:** Download the full manifest to verify it fits on the target device. Monitor disk usage during and after sync completes.

**Fail condition:** Catalog exceeds available disk space on kiosk hardware. Downloads stall or fail when `maxCacheBytes` or `reserveFreeBytes` limits are hit. Partial sync leaves kiosk with incomplete content.

**Fix:** For smoke tests, scope down the manifest to a subset. For production validation, verify the device has capacity for the full catalog plus `reserveFreeBytes` headroom. Calculate: total manifest size + reserve + OS needs < device disk capacity.

## Common Mistakes

### CRITICAL: devPassthrough left enabled in production

In production Electron builds, `NODE_ENV` may be unset — which defaults `devPassthrough` to `false`. But if `NODE_ENV` is explicitly set to `"development"` in a deployed build (common with misconfigured build tooling), all downloads are silently skipped and the app serves only remote URLs. The kiosk works on the network but fails offline.

Wrong — relying on `NODE_ENV`:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveManifest: async () => manifest,
});
```

Correct — explicit:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  resolveManifest: async () => manifest,
});
```

Source: media-cache.ts; types.ts
Cross-skill: also in cache-configuration/SKILL.md § Common Mistakes

### CRITICAL: Shipping with only dev passthrough testing

`devPassthrough` bypasses real storage, protocol serving, and filesystem permissions. Platform-specific issues only surface in offline mode:

- `media://` protocol URLs may be blocked by CSP or DOM security in certain Electron configurations.
- Disk space for the full catalog is untested.
- `resolveAssetRequest` is never called — authenticated downloads are untested.
- `onSyncFailure: "serve-last-snapshot"` is overridden to `"throw"` — resilience logic is untested.

Wrong — testing only in dev mode:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: true,
  resolveManifest: async () => manifest,
});
// "It works!" — but only because assets load from remote URLs
```

Correct — test with production configuration before deploying:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  onSyncFailure: "serve-last-snapshot",
  resolveManifest: async () => manifest,
});
// Build, run, verify media:// URLs render, verify sync completes
```

Source: Maintainer interview

### HIGH: No storage limits on limited disk

Without `maxCacheBytes` or `reserveFreeBytes`, the cache downloads everything in the manifest with no cap. On kiosk SSDs (often 64–256 GB), a growing catalog can consume all disk space.

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  resolveManifest: async () => manifest,
});
```

Correct:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  maxCacheBytes: 10 * 1024 * 1024 * 1024,
  reserveFreeBytes: 1 * 1024 * 1024 * 1024,
  resolveManifest: async () => manifest,
});
```

Source: README

### HIGH: Switching to offline mode without considering disk space

When disabling `devPassthrough` for the first time, the full catalog downloads to the local machine. Developers on laptops with limited free space may run out of disk during the first sync. Large production catalogs (tens of GB of video) amplify this.

Wrong — disabling passthrough without checking space:

```typescript
// Was devPassthrough: true during development, now switching for production testing
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  resolveManifest: async () => fullProductionManifest,
});
```

Correct — scope down manifest for local testing:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  maxCacheBytes: 2 * 1024 * 1024 * 1024,
  resolveManifest: async () => scopedTestManifest,
});
```

Source: Maintainer interview

### MEDIUM: Default console logging in production

When `logging.onLog` is omitted and `NODE_ENV !== "production"`, the package prints to `console`. On headless kiosks, console output goes nowhere. Sync failures, download errors, and storage warnings are silently lost.

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  resolveManifest: async () => manifest,
});
```

Correct:

```typescript
import pino from "pino";

const logger = pino({ name: "media-cache" });

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  logging: {
    level: "info",
    onLog: (entry) => {
      logger[entry.level === "debug" ? "debug" : entry.level](entry, entry.event);
    },
  },
  resolveManifest: async () => manifest,
});
```

Source: media-cache.ts; README

### MEDIUM: Using package for user-generated content

Wrong:

```typescript
ipcMain.handle("save-webcam-photo", async (_event, photoBuffer: Buffer) => {
  await mediaCache.writeAsset("user-photos", "selfie", photoBuffer);
});
```

Correct:

```typescript
import { writeFile } from "node:fs/promises";
import { app } from "electron";
import path from "node:path";

ipcMain.handle("save-webcam-photo", async (_event, photoBuffer: Buffer) => {
  const userDataPath = path.join(app.getPath("userData"), "user-photos");
  await writeFile(path.join(userDataPath, "selfie.jpg"), photoBuffer);
});
```

The cache is read-only for presentation assets. No write operations are exposed to the renderer. Use standard Node.js file APIs for user-generated content like webcam photos or uploads.

Source: Maintainer interview

### HIGH Tension: Dev passthrough simplicity vs production correctness

`devPassthrough` makes development fast but changes behavior: `resolveAssetRequest` is ignored, `onSyncFailure` is overridden to `"throw"`, URLs are remote. Code working in dev may break in production offline mode — especially authenticated downloads and sync failure resilience.

See also: cache-configuration/SKILL.md § Common Mistakes

### HIGH Tension: Sync resilience vs stale content

`"serve-last-snapshot"` never shows a blank screen but may serve outdated content indefinitely if syncs keep failing. `"throw"` is honest but leaves the UI empty. Choose based on whether stale content or no content is worse for your kiosk use case.

See also: cache-configuration/SKILL.md § Common Mistakes

## Pre-Deploy Summary

- [ ] `devPassthrough: false` set explicitly
- [ ] `onSyncFailure` mode chosen deliberately
- [ ] `app.requestSingleInstanceLock()` in place
- [ ] `maxCacheBytes` and/or `reserveFreeBytes` set for device
- [ ] `storagePath` writable on target platform
- [ ] `logging.onLog` wired to production log sink
- [ ] Package used only for read-only presentation assets
- [ ] Offline mode tested with real storage path and media:// URLs
- [ ] Full catalog fits on target device disk

---

See also: cache-configuration/SKILL.md — All createMediaCache options
See also: getting-started/SKILL.md — Initial wiring and setup
See also: authenticated-downloads/SKILL.md — Verify auth works in offline mode
