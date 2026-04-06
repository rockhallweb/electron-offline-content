---
name: react-rendering
description: >
  React bindings for @rockhallweb/electron-offline-content:
  MediaCacheProvider context, useMediaCacheStatus for sync phase and
  progress, useMediaItem and useMediaItems for querying cached content
  by namespace, useFileStemMatch for filename search, useMediaCacheReady
  for download gates, useMediaCacheErrors for aggregated error display.
  AsyncState shape, refetchOnSyncComplete, assetsByRole convenience
  lookup, rendering media:// URLs in video/img/audio/track elements.
type: framework
library: electron-offline-content
framework: react
library_version: "0.1.1"
requires:
  - getting-started
sources:
  - "rockhallweb/electron-offline-content:src/react/index.tsx"
  - "rockhallweb/electron-offline-content:src/shared/types.ts"
---

This skill builds on getting-started. Read it first for full main → preload → renderer wiring.

## Setup

Wrap your renderer entry with `MediaCacheProvider`. The bridge is auto-detected from `window.mediaCache` when omitted.

```tsx
import { MediaCacheProvider } from "@rockhallweb/electron-offline-content/react";

function App() {
  return (
    <MediaCacheProvider>
      <KioskShell />
    </MediaCacheProvider>
  );
}
```

Gate content rendering on first sync completion, then render items:

```tsx
import { useMediaCacheReady, useMediaItems } from "@rockhallweb/electron-offline-content/react";

function KioskShell() {
  const ready = useMediaCacheReady();
  const videos = useMediaItems("videos", { limit: 50 });

  if (ready.loading || !ready.data?.ready) {
    return <div>Preparing content…</div>;
  }

  if (videos.loading) return <div>Loading videos…</div>;

  return (
    <ul>
      {videos.data?.items.map((item) => (
        <li key={item.id}>
          <video src={item.assetsByRole.primary?.url} controls />
          <span>{item.title}</span>
        </li>
      ))}
    </ul>
  );
}
```

## Hooks and Components

### Loading gate with useMediaCacheReady

Returns `AsyncState<MediaCacheReadyState>` where `MediaCacheReadyState` has `{ ready, syncing, phase, activeGenerationId, syncError }`.

Use as a gate before rendering any content that depends on cached media.

```tsx
import { useMediaCacheReady } from "@rockhallweb/electron-offline-content/react";

function LoadingGate({ children }: { children: React.ReactNode }) {
  const { data, loading } = useMediaCacheReady();

  if (loading || !data?.ready) {
    return (
      <div className="loading-screen">
        <p>Preparing content…</p>
        {data?.syncing && <p>Downloading assets…</p>}
      </div>
    );
  }

  return <>{children}</>;
}
```

### Querying items with useMediaItems

Returns `AsyncState<PaginationResult<ResolvedMediaContentItem>>`. Supports `limit`, `cursor`, `recursive`, and `refetchOnSyncComplete`.

Flat namespace query:

```tsx
import { useMediaItems } from "@rockhallweb/electron-offline-content/react";

function VideoList() {
  const { data, loading, error, refresh } = useMediaItems("videos", {
    limit: 20,
    refetchOnSyncComplete: true,
  });

  if (loading) return <p>Loading…</p>;
  if (error) return <p>Error: {error.message}</p>;

  return (
    <ul>
      {data?.items.map((item) => (
        <li key={item.id}>{item.title}</li>
      ))}
    </ul>
  );
}
```

Recursive tree query across nested namespaces:

```tsx
function AllMedia() {
  const { data, loading } = useMediaItems("exhibits.floor-2", {
    recursive: true,
    limit: 100,
  });

  if (loading || !data) return null;

  return (
    <div>
      {data.items.map((item) => (
        <figure key={`${item.namespace}/${item.id}`}>
          <img src={item.assetsByRole.thumbnail?.url} alt={item.title} />
          <figcaption>
            {item.namespace} — {item.title}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
```

### Single item lookup with useMediaItem

Returns `AsyncState<ResolvedMediaContentItem | null>`. Fetches one item by exact namespace and id.

```tsx
import { useMediaItem } from "@rockhallweb/electron-offline-content/react";

function InducteeProfile({ inducteeId }: { inducteeId: string }) {
  const { data: item, loading } = useMediaItem("inductees", inducteeId, {
    refetchOnSyncComplete: true,
  });

  if (loading || !item) return <p>Loading profile…</p>;

  return (
    <article>
      <h2>{item.title}</h2>
      <p>{item.description}</p>
      <video src={item.assetsByRole.primary?.url} poster={item.assetsByRole.poster?.url} controls />
      {item.assets
        .filter((a) => a.role === "gallery")
        .map((asset) => (
          <img key={asset.id} src={asset.url} alt="" />
        ))}
    </article>
  );
}
```

### Sync progress with useMediaCacheStatus

Returns `AsyncState<MediaCacheStatus>` with `phase`, `progress`, `storageRoot`, `activeGenerationId`, `lastRun`, and `error`.

```tsx
import { useMediaCacheStatus } from "@rockhallweb/electron-offline-content/react";

function SyncOverlay() {
  const { data: status, loading } = useMediaCacheStatus();

  if (loading || !status) return null;
  if (status.phase !== "syncing") return null;

  const { progress } = status;

  return (
    <div className="sync-overlay">
      <p>Syncing…</p>
      {progress && <progress value={progress.completedAssets} max={progress.totalAssets} />}
      {progress && (
        <p>
          {progress.completedAssets}/{progress.totalAssets} assets (
          {(progress.bytesDownloaded / 1_048_576).toFixed(1)} MB)
        </p>
      )}
    </div>
  );
}
```

### Error aggregation with useMediaCacheErrors

Takes a shared `MediaCacheStatusState` and any number of query states. Returns `MediaCacheErrors` with `{ hasError, primaryError, syncError, statusError, queryErrors }`.

```tsx
import {
  useMediaCacheStatus,
  useMediaItems,
  useMediaCacheErrors,
} from "@rockhallweb/electron-offline-content/react";

function ExhibitPage() {
  const status = useMediaCacheStatus();
  const videos = useMediaItems("videos", { limit: 50 });
  const images = useMediaItems("images", { limit: 100 });

  const errors = useMediaCacheErrors(status, videos, images);

  if (errors.hasError) {
    return (
      <div className="error-banner">
        <p>Something went wrong: {errors.primaryError?.message}</p>
        {errors.syncError && <p>Sync failed — content may be stale.</p>}
      </div>
    );
  }

  return <div>{/* render videos.data and images.data */}</div>;
}
```

### File stem matching with useFileStemMatch

Returns `AsyncState<PaginationResult<FileStemMatch>>`. Searches cached content by filename stem across namespaces.

```tsx
import { useFileStemMatch } from "@rockhallweb/electron-offline-content/react";

function AssetSearch({ query }: { query: string }) {
  const { data, loading } = useFileStemMatch(query, {
    limit: 25,
    namespace: "exhibits",
    refetchOnSyncComplete: true,
  });

  if (loading || !data) return <p>Searching…</p>;

  return (
    <ul>
      {data.items.map((match) => (
        <li key={`${match.item.namespace}/${match.item.id}`}>
          {match.item.namespace}/{match.item.id}
        </li>
      ))}
    </ul>
  );
}
```

### Rendering media:// URLs

URLs from hook results work directly in `src` attributes. In offline mode they resolve through the `media://` protocol handler registered in main. In `devPassthrough` mode they are remote HTTPS URLs. Never construct these URLs manually.

```tsx
function MediaPlayer({ item }: { item: ResolvedMediaContentItem }) {
  const video = item.assetsByRole.primary;
  const caption = item.assetsByRole.captions;
  const poster = item.assetsByRole.poster;

  return (
    <video src={video?.url} poster={poster?.url} controls autoPlay muted>
      {caption && <track src={caption.url} kind="subtitles" srcLang="en" default />}
    </video>
  );
}
```

Audio assets work the same way:

```tsx
function AudioPlayer({ item }: { item: ResolvedMediaContentItem }) {
  const audio = item.assetsByRole.primary;

  return <audio src={audio?.url} controls />;
}
```

## Common Mistakes

### HIGH: Accessing data before loading completes

All hooks return `AsyncState<T>` where `data` is `null` until the first successful load. Accessing nested properties without a null check causes a `TypeError` at runtime.

```tsx
// WRONG — TypeError when data is null
function Broken() {
  const items = useMediaItems("videos");
  return (
    <ul>
      {items.data.items.map((i) => (
        <li key={i.id}>{i.title}</li>
      ))}
    </ul>
  );
}

// CORRECT — guard on loading and null
function Fixed() {
  const items = useMediaItems("videos");
  if (items.loading || !items.data) return <p>Loading…</p>;
  return (
    <ul>
      {items.data.items.map((i) => (
        <li key={i.id}>{i.title}</li>
      ))}
    </ul>
  );
}
```

Source: `react/index.tsx` — `AsyncState` type definition

### HIGH: Fetching remote URLs instead of rendering directly

Hook URLs are ready to render. Do not `fetch()` them in the renderer — it bypasses the protocol handler in offline mode and adds unnecessary complexity.

```tsx
// WRONG — redundant fetch, breaks offline
function Broken({ item }: { item: ResolvedMediaContentItem }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    fetch(item.assetsByRole.primary!.url)
      .then((r) => r.blob())
      .then((b) => setSrc(URL.createObjectURL(b)));
  }, [item]);
  return <video src={src} />;
}

// CORRECT — pass URL directly to src
function Fixed({ item }: { item: ResolvedMediaContentItem }) {
  return <video src={item.assetsByRole.primary?.url} controls />;
}
```

Source: Maintainer interview

### MEDIUM: Using deprecated useMediaNamespace hooks

`useMediaNamespace` and `useMediaNamespaceTree` are deprecated. They still work but will be removed before 1.0.

```tsx
// WRONG — deprecated API
const items = useMediaNamespace("videos", { limit: 20 });
const tree = useMediaNamespaceTree("exhibits", { limit: 50 });

// CORRECT — current API
const items = useMediaItems("videos", { limit: 20 });
const tree = useMediaItems("exhibits", { recursive: true, limit: 50 });
```

Source: `react/index.tsx` — `@deprecated` JSDoc annotations

### MEDIUM: Multiple independent useMediaCacheStatus subscriptions

`useMediaCacheErrors` accepts a shared status object to avoid redundant IPC subscriptions. Calling `useMediaCacheStatus` in multiple sibling components creates duplicate listeners.

```tsx
// WRONG — two subscriptions for the same data
function VideoPanel() {
  const status = useMediaCacheStatus();
  const videos = useMediaItems("videos");
  const errors = useMediaCacheErrors(status, videos);
  // ...
}
function ImagePanel() {
  const status = useMediaCacheStatus(); // duplicate subscription
  const images = useMediaItems("images");
  const errors = useMediaCacheErrors(status, images);
  // ...
}

// CORRECT — lift status to parent, pass down
function ExhibitPage() {
  const status = useMediaCacheStatus();
  return (
    <>
      <VideoPanel status={status} />
      <ImagePanel status={status} />
    </>
  );
}
```

Source: `react/index.tsx` — `useMediaCacheErrors` JSDoc

### MEDIUM: Hardcoding media:// URLs instead of using hook data

URLs differ between offline mode (`media://`) and `devPassthrough` mode (remote HTTPS). Hardcoded URLs break in one of the two modes.

```tsx
// WRONG — hardcoded protocol URL
<video src="media://asset/videos/welcome/main" />;

// CORRECT — URL from hook result
const { data: item } = useMediaItem("videos", "welcome");
<video src={item?.assetsByRole.primary?.url} />;
```

Source: README — devPassthrough documentation

---

See also: getting-started/SKILL.md — Full main → preload → renderer wiring
See also: manifest-authoring/SKILL.md — Namespace organization determines how hooks query content

## References

- [Complete hooks API reference](references/hooks.md)
