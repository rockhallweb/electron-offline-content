---
name: getting-started
description: >
  Full greenfield integration of @rockhallweb/electron-offline-content:
  install, write resolveManifest, configure createMediaCache in main,
  wire preload bridge with exposeMediaCacheBridge, add MediaCacheProvider
  and hooks in React, render first content offline. Covers
  app.requestSingleInstanceLock, createMediaCache timing relative to
  app.whenReady, and mediaCache.start() fire-and-forget pattern.
type: lifecycle
library: electron-offline-content
library_version: "0.1.1"
sources:
  - "rockhallweb/electron-offline-content:README.md"
  - "rockhallweb/electron-offline-content:src/main/index.ts"
  - "rockhallweb/electron-offline-content:src/main/media-cache.ts"
  - "rockhallweb/electron-offline-content:src/preload/index.ts"
  - "rockhallweb/electron-offline-content:src/react/index.tsx"
  - "rockhallweb/electron-offline-content:examples/local/src/main.ts"
---

# Getting Started

## Setup

Install the package:

```bash
pnpm add @rockhallweb/electron-offline-content
```

Prerequisites: Node.js >= 24, Electron >= 40. React >= 18 is an optional peer dependency needed only for the `/react` export.

Three files wire the integration across all three Electron processes: main, preload, and renderer.

### main.ts

```typescript
import { app, BrowserWindow } from "electron";
import path from "node:path";
import {
  createMediaCache,
  defineManifest,
  defineManifestItem,
  defineManifestAsset,
} from "@rockhallweb/electron-offline-content/main";

if (!app.requestSingleInstanceLock()) {
  app.exit(1);
}

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveManifest: async () => {
    const res = await fetch("https://cms.example.com/api/content");
    const data = await res.json();
    return defineManifest({
      namespaces: [
        {
          key: "videos",
          items: data.videos.map((v: any) =>
            defineManifestItem({
              id: v.slug,
              version: v.updatedAt,
              kind: "video",
              title: v.title,
              assets: [
                defineManifestAsset({
                  id: "main",
                  role: "primary",
                  kind: "video",
                  source: { url: v.videoUrl },
                }),
              ],
            }),
          ),
        },
      ],
    });
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
4. `mediaCache.start()` — after `app.whenReady()`, without `await`. Fire-and-forget; React hooks show progress while sync runs in the background.

### preload.ts

```typescript
import { exposeMediaCacheBridge } from "@rockhallweb/electron-offline-content/preload";

exposeMediaCacheBridge();
```

This calls `contextBridge.exposeInMainWorld` to put the IPC bridge on `window.mediaCache`. All React hooks depend on this bridge.

### App.tsx

```tsx
import {
  MediaCacheProvider,
  useMedia,
  useMediaCacheReady,
} from "@rockhallweb/electron-offline-content/react";

function Content() {
  const ready = useMediaCacheReady();
  const videos = useMedia({ kind: "list", namespace: "videos", limit: 20 });

  if (!ready.data?.ready) return <p>Preparing offline content...</p>;
  if (videos.loading) return <p>Loading...</p>;

  return (
    <div>
      {videos.data?.items.map((item) => (
        <video
          key={item.id}
          src={item.assetsByRole.primary?.url}
          poster={item.assetsByRole.poster?.url}
          controls
        />
      ))}
    </div>
  );
}

export function App() {
  return (
    <MediaCacheProvider>
      <Content />
    </MediaCacheProvider>
  );
}
```

`MediaCacheProvider` must wrap any component that uses hooks. Hook URLs (`item.assetsByRole.primary?.url`) resolve to `media://` in offline mode or remote URLs in dev passthrough — pass them directly to `src` attributes.

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

### Using define helpers for readable manifests

The `defineManifestAsset`, `defineManifestItem`, and `defineManifest` helpers validate each piece individually and surface errors at the point of definition. Build assets and items as standalone variables to keep nesting shallow:

```typescript
import {
  defineManifest,
  defineManifestItem,
  defineManifestAsset,
} from "@rockhallweb/electron-offline-content/main";

const mainVideo = defineManifestAsset({
  id: "main",
  role: "primary",
  kind: "video",
  source: { url: "https://cdn.example.com/welcome.v2.mp4" },
});

const posterImage = defineManifestAsset({
  id: "poster",
  role: "poster",
  kind: "poster",
  source: { url: "https://cdn.example.com/welcome-poster.jpg" },
});

const welcomeItem = defineManifestItem({
  id: "welcome",
  version: "v2",
  kind: "video",
  title: "Welcome Video",
  assets: [mainVideo, posterImage],
});

const manifest = defineManifest({
  namespaces: [{ key: "lobby", items: [welcomeItem] }],
});
```

Compared to inline nesting, this produces clearer validation errors (the asset or item that failed is obvious) and keeps each definition under ~8 lines.

## Common Mistakes

### CRITICAL: Creating cache after app.whenReady()

`createMediaCache()` must be called BEFORE `app.whenReady()`. The constructor calls `protocol.registerSchemesAsPrivileged` to register the `media:` scheme, which Electron requires before the app ready event. Constructing after ready causes silent scheme registration failure.

Wrong:

```typescript
import { app } from "electron";
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";

await app.whenReady();
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveManifest: async () => manifest,
});
await mediaCache.start();
```

Correct:

```typescript
import { app } from "electron";
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveManifest: async () => manifest,
});

await app.whenReady();
mediaCache.start();
```

Source: README; media-cache.ts constructor calls `ensureMediaCacheProtocolSchemesPrivileged()`

### CRITICAL: Missing preload bridge setup

Without `exposeMediaCacheBridge()` in the preload script, `window.mediaCache` is undefined and all React hooks throw `"MediaCache bridge is unavailable"`.

Wrong:

```typescript
import { contextBridge } from "electron";
```

Correct:

```typescript
import { exposeMediaCacheBridge } from "@rockhallweb/electron-offline-content/preload";

exposeMediaCacheBridge();
```

Source: react/index.tsx `useMediaBridge()` throw

### HIGH: Missing MediaCacheProvider in React tree

All query hooks require a `MediaCacheProvider` ancestor. Without it, `useMediaBridge()` and the query hooks throw.

Wrong:

```tsx
import { useMedia } from "@rockhallweb/electron-offline-content/react";

function App() {
  const items = useMedia({ kind: "list", namespace: "videos", limit: 20 });
  return (
    <div>
      {items.data?.items.map((item) => (
        <p key={item.id}>{item.title}</p>
      ))}
    </div>
  );
}
```

Correct:

```tsx
import { MediaCacheProvider, useMedia } from "@rockhallweb/electron-offline-content/react";

function Content() {
  const items = useMedia({ kind: "list", namespace: "videos", limit: 20 });
  return (
    <div>
      {items.data?.items.map((item) => (
        <p key={item.id}>{item.title}</p>
      ))}
    </div>
  );
}

function App() {
  return (
    <MediaCacheProvider>
      <Content />
    </MediaCacheProvider>
  );
}
```

Source: react/index.tsx `MediaCacheProvider`

### HIGH: Forgetting app.requestSingleInstanceLock()

Without the instance lock, a second Electron process can launch and collide on the same storage root, causing `StorageOwnershipError`. The error surfaces at `start()` time, not at construction.

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveManifest: async () => manifest,
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
  resolveManifest: async () => manifest,
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

React hooks (`useMediaCacheReady`, `useMediaCacheStatus`) show sync progress while the download runs in the background.

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

### HIGH Tension: Manifest flexibility vs validation strictness

`resolveManifest` accepts multiple input shapes (full manifest, namespace array, item array) for convenience, but validation is strict on uniqueness and required fields. Agents using flexible shorthand may forget the required `version` field or produce duplicate keys, causing errors at sync time.

See also: manifest-authoring/SKILL.md § Common Mistakes

---

See also: manifest-authoring/SKILL.md — Writing resolveManifest functions and using define helpers
See also: cache-configuration/SKILL.md — All createMediaCache options
See also: react-rendering/SKILL.md — Complete React hooks API
