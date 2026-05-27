---
name: getting-started
description: >
  Full greenfield integration of @rockhall/electron-offline-content:
  install, write resolveStore with createMediaStore, configure
  createMediaCache in main, wire preload bridge with
  exposeMediaCacheBridge, create the framework-agnostic renderer client,
  render first content offline. Covers app.requestSingleInstanceLock,
  createMediaCache timing relative to app.whenReady, and
  mediaCache.start() fire-and-forget pattern.
type: lifecycle
library: electron-offline-content
library_version: "0.4.1"
sources:
  - "rockhallweb/electron-offline-content:README.md"
  - "rockhallweb/electron-offline-content:src/main/index.ts"
  - "rockhallweb/electron-offline-content:src/main/media-cache.ts"
  - "rockhallweb/electron-offline-content:src/main/store.ts"
  - "rockhallweb/electron-offline-content:src/preload/index.ts"
  - "rockhallweb/electron-offline-content:src/renderer/index.ts"
  - "rockhallweb/electron-offline-content:examples/local/src/main.ts"
---

# Getting Started

## Setup

Install the package:

```bash
pnpm add @rockhall/electron-offline-content
```

Prerequisites: Node.js >= 24, Electron >= 40.

Three files wire the integration across all three Electron processes: main, preload, and renderer.

### main.ts

```typescript
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { createMediaCache, createMediaStore } from "@rockhall/electron-offline-content/main";

if (!app.requestSingleInstanceLock()) {
  app.exit(1);
}

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveStore: async () => {
    const res = await fetch("https://cms.example.com/api/content");
    const data = await res.json();

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

    return store;
  },
});

async function bootstrap() {
  await app.whenReady();
  const win = new BrowserWindow({
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile("index.html");
  mediaCache.start();
}

bootstrap();
```

Key ordering constraints:

1. `app.requestSingleInstanceLock()` — before anything else.
2. `createMediaCache()` — before `app.whenReady()`. The constructor registers `media:` as a privileged scheme, which must happen before the app ready event.
3. `BrowserWindow` creation — after `app.whenReady()`.
4. `mediaCache.start()` — after `app.whenReady()`, without `await`. Fire-and-forget; renderer status subscriptions show progress while sync runs in the background.

### preload.ts

```typescript
import { exposeMediaCacheBridge } from "@rockhall/electron-offline-content/preload";

exposeMediaCacheBridge();
```

This calls `contextBridge.exposeInMainWorld` to put the IPC bridge on `window.mediaCache`. The renderer client resolves this bridge by default.

### renderer.ts

```typescript
import { createMediaCacheRenderer } from "@rockhall/electron-offline-content/renderer";

const renderer = createMediaCacheRenderer();
const container = document.querySelector<HTMLDivElement>("#videos");

const unsubscribe = renderer.watchMediaByIndex("category", "videos", { limit: 20 }, (videos) => {
  if (!container) return;
  if (videos.loading) {
    container.textContent = "Preparing offline content...";
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

Resolved asset URLs (`asset.url`) resolve to `media://` in offline mode or remote URLs in dev passthrough — pass them directly to `src` attributes.

## Core Patterns

### Controlling start() timing

`mediaCache.start()` is fire-and-forget. It registers the protocol handler, attaches IPC listeners, and kicks off the initial sync. Do not `await` it at app launch — that blocks window creation until the entire download completes.

You control when syncing begins. It does not have to happen at launch:

```typescript
async function bootstrap() {
  await app.whenReady();
  const win = new BrowserWindow({
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile("index.html");
  mediaCache.start();
}
```

To defer syncing until user confirmation, skip `start()` in bootstrap and trigger it from the renderer via IPC:

```typescript
import { ipcMain } from "electron";

ipcMain.handle("begin-sync", () => {
  mediaCache.start();
});
```

### Building a media store with createMediaStore

`createMediaStore()` creates a flat asset store. Add assets with `store.add(assetKey, input)` and define secondary indexes with `store.defineIndex()` for querying. The first argument is an `AssetKeyInput` (`string` or `readonly string[]`); resolved assets expose `key` (hash) and `displayKey` (human-readable).

```typescript
import { createMediaStore } from "@rockhall/electron-offline-content/main";

const store = createMediaStore();

const category = store.defineIndex("category");
const year = store.defineIndex("year");

store.add(["video", "welcome"], {
  version: "v2",
  mimeType: "video/mp4",
  url: "https://cdn.example.com/welcome.v2.mp4",
  metadata: { title: "Welcome Video", category: "lobby", year: 2026 },
  indexes: [category("lobby"), year("2026")],
});

store.add(["image", "welcome-poster"], {
  version: "v2",
  mimeType: "image/jpeg",
  url: "https://cdn.example.com/welcome-poster.jpg",
  metadata: { title: "Welcome Poster", category: "lobby", year: 2026 },
  indexes: [category("lobby"), year("2026")],
});
```

Compared to deep nesting, this produces clearer validation errors (the asset that failed is obvious) and keeps each definition under ~8 lines.

## Common Mistakes

### CRITICAL: Creating cache after app.whenReady()

`createMediaCache()` must be called BEFORE `app.whenReady()`. The constructor calls `protocol.registerSchemesAsPrivileged` to register the `media:` scheme, which Electron requires before the app ready event. Constructing after ready causes silent scheme registration failure.

Wrong:

```typescript
import { app } from "electron";
import { createMediaCache } from "@rockhall/electron-offline-content/main";

await app.whenReady();
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveStore: async () => store,
});
await mediaCache.start();
```

Correct:

```typescript
import { app } from "electron";
import { createMediaCache } from "@rockhall/electron-offline-content/main";

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveStore: async () => store,
});

await app.whenReady();
mediaCache.start();
```

Source: README; media-cache.ts constructor calls `ensureMediaCacheProtocolSchemesPrivileged()`

### CRITICAL: Missing preload bridge setup

Without `exposeMediaCacheBridge()` in the preload script, `window.mediaCache` is undefined and `createMediaCacheRenderer()` throws `"MediaCache bridge is unavailable"`.

Wrong:

```typescript
import { contextBridge } from "electron";
```

Correct:

```typescript
import { exposeMediaCacheBridge } from "@rockhall/electron-offline-content/preload";

exposeMediaCacheBridge();
```

Source: renderer/runtime.ts `resolveMediaCacheBridge()`

### HIGH: Forgetting app.requestSingleInstanceLock()

Without the instance lock, a second Electron process can launch and collide on the same storage root, causing `StorageOwnershipError`. The error surfaces at `start()` time, not at construction.

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveStore: async () => store,
});

async function bootstrap() {
  await app.whenReady();
  mediaCache.start();
}

bootstrap();
```

Correct:

```typescript
if (!app.requestSingleInstanceLock()) {
  app.exit(1);
}

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveStore: async () => store,
});

async function bootstrap() {
  await app.whenReady();
  mediaCache.start();
}

bootstrap();
```

Source: README; examples/local/src/main.ts

### HIGH: Awaiting mediaCache.start() at app launch

`start()` begins the async download pipeline. Awaiting it before creating a window blocks the UI until the entire sync completes — the app appears blank until all assets download.

Wrong:

```typescript
await app.whenReady();
await mediaCache.start();
createWindow();
```

Correct:

```typescript
await app.whenReady();
createWindow();
mediaCache.start();
```

Renderer status subscriptions show sync progress while the download runs in the background.

Source: Maintainer interview; media-cache.ts

### MEDIUM: Not realizing start() timing is flexible

Wrong:

```typescript
async function bootstrap() {
  await app.whenReady();
  mediaCache.start();
  createWindow();
}
```

Correct:

```typescript
async function bootstrap() {
  await app.whenReady();
  createWindow();

  ipcMain.handle("user-confirmed-download", () => {
    mediaCache.start();
  });
}
```

`start()` does not need to run at app launch. Developers control when syncing begins — after user confirmation, after other initialization, or triggered by a renderer button via IPC.

Source: Maintainer interview

### HIGH Tension: Store validation vs sync-time failures

`resolveStore` must return a valid **`MediaStore`**. Validation is strict on required fields like `version` and HTTP(S) asset URLs; keys must be non-empty (`AssetKeyInput`) but are not otherwise content-validated. Use **`createMediaStore`** and **`store.add()`** so errors surface when you build the store, not only during sync.

See also: store-authoring/SKILL.md § Common Mistakes

---

See also: store-authoring/SKILL.md — Writing resolveStore functions and using createMediaStore
See also: cache-configuration/SKILL.md — All createMediaCache options
