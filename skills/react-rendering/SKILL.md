---
name: react-rendering
description: >
  React bindings for @rockhallweb/electron-offline-content:
  MediaCacheProvider context, useMediaAsset for single asset lookups,
  useMediaByIndex for index-based queries, useMediaBridge and
  useMediaCacheStatus for sync phase and progress, useFileStemMatch
  for filename search, useMediaCacheReady for download gates, and
  useMediaCacheErrors for aggregated error display. AsyncState shape,
  refetchOnSyncComplete, rendering media:// URLs in video/img/audio/track
  elements.
type: framework
library: electron-offline-content
framework: react
library_version: "0.4.0"
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

Gate content rendering on first sync completion, then render assets:

```tsx
import { useMediaByIndex, useMediaCacheReady } from "@rockhallweb/electron-offline-content/react";

function KioskShell() {
  const ready = useMediaCacheReady();
  const videos = useMediaByIndex("category", "videos", { limit: 50 });

  if (ready.loading || !ready.data?.ready) {
    return <div>Preparing content…</div>;
  }

  if (videos.loading) return <div>Loading videos…</div>;

  return (
    <ul>
      {videos.data?.items.map((asset) => (
        <li key={asset.key}>
          <video src={asset.url} controls />
          <span>{asset.metadata.title as string}</span>
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

### Single asset lookup with useMediaAsset

Returns `AsyncState<ResolvedMediaAsset>` for a single asset by key.

```tsx
import { useMediaAsset } from "@rockhallweb/electron-offline-content/react";

function WelcomeVideo() {
  const { data: asset, loading } = useMediaAsset("video/welcome");

  if (loading || !asset) return <p>Loading…</p>;

  return <video src={asset.url} controls />;
}
```

Use `useMediaAsset` when you know the exact asset key. Asset keys come from the `key` field passed to `store.add()` during `resolveStore`.

### Index-based queries with useMediaByIndex

Returns `AsyncState<PaginationResult<ResolvedMediaAsset>>` for assets matching an index value.

```tsx
import { useMediaByIndex } from "@rockhallweb/electron-offline-content/react";

function VideoList() {
  const { data, loading, error, refresh } = useMediaByIndex("category", "videos", {
    limit: 20,
    refetchOnSyncComplete: true,
  });

  if (loading) return <p>Loading…</p>;
  if (error) return <p>Error: {error.message}</p>;

  return (
    <ul>
      {data?.items.map((asset) => (
        <li key={asset.key}>{asset.metadata.title as string}</li>
      ))}
    </ul>
  );
}
```

Query by any index defined in `resolveStore`:

```tsx
function FloorExhibits({ floor }: { floor: string }) {
  const { data, loading } = useMediaByIndex("floor", floor, {
    limit: 100,
    refetchOnSyncComplete: true,
  });

  if (loading || !data) return null;

  return (
    <div>
      {data.items.map((asset) => (
        <figure key={asset.key}>
          <img src={asset.url} alt={asset.metadata.title as string} />
          <figcaption>{asset.metadata.title as string}</figcaption>
        </figure>
      ))}
    </div>
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

### Imperative bridge access with useMediaBridge

Returns bridge methods together with shared `status` and aggregated `errors`.

```tsx
import { useMediaBridge } from "@rockhallweb/electron-offline-content/react";

function DownloadButton() {
  const { syncNow, status, errors } = useMediaBridge();

  return (
    <button
      type="button"
      disabled={status.data?.phase === "syncing"}
      onClick={() => void syncNow()}
    >
      {errors.hasError ? `Retry sync (${errors.primaryError?.message})` : "Sync now"}
    </button>
  );
}
```

### Error aggregation with useMediaCacheErrors

Returns `MediaCacheErrors` with `{ hasError, primaryError, syncError, statusError, queryErrors }`.

```tsx
import { useMediaByIndex, useMediaCacheErrors } from "@rockhallweb/electron-offline-content/react";

function ExhibitPage() {
  const videos = useMediaByIndex("category", "videos", { limit: 50 });
  const images = useMediaByIndex("category", "images", { limit: 100 });
  const errors = useMediaCacheErrors();

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

Returns `AsyncState<PaginationResult<FileStemMatch>>`. Searches cached content by filename stem across all assets.

```tsx
import { useFileStemMatch } from "@rockhallweb/electron-offline-content/react";

function AssetSearch({ query }: { query: string }) {
  const { data, loading } = useFileStemMatch(query, {
    limit: 25,
    refetchOnSyncComplete: true,
  });

  if (loading || !data) return <p>Searching…</p>;

  return (
    <ul>
      {data.items.map((match) => (
        <li key={match.asset.key}>{match.asset.key}</li>
      ))}
    </ul>
  );
}
```

### Rendering media:// URLs

URLs from hook results work directly in `src` attributes. In offline mode they resolve through the `media://` protocol handler registered in main. In `devPassthrough` mode they are remote HTTPS URLs. Never construct these URLs manually.

```tsx
function MediaPlayer({ asset }: { asset: ResolvedMediaAsset }) {
  return <video src={asset.url} controls autoPlay muted />;
}
```

Audio assets work the same way:

```tsx
function AudioPlayer({ asset }: { asset: ResolvedMediaAsset }) {
  return <audio src={asset.url} controls />;
}
```

For related assets (e.g. a video with a poster and subtitles), look up each asset by key:

```tsx
function VideoWithExtras({ videoKey }: { videoKey: string }) {
  const video = useMediaAsset(videoKey);
  const poster = useMediaAsset(`${videoKey}/poster`);
  const subs = useMediaAsset(`${videoKey}/subs-en`);

  if (video.loading || !video.data) return <p>Loading…</p>;

  return (
    <video src={video.data.url} poster={poster.data?.url} controls>
      {subs.data && <track src={subs.data.url} kind="subtitles" srcLang="en" default />}
    </video>
  );
}
```

## Common Mistakes

### HIGH: Accessing data before loading completes

All hooks return `AsyncState<T>` where `data` is `null` until the first successful load. Accessing nested properties without a null check causes a `TypeError` at runtime.

```tsx
// WRONG — TypeError when data is null
function Broken() {
  const videos = useMediaByIndex("category", "videos");
  return (
    <ul>
      {videos.data.items.map((asset) => (
        <li key={asset.key}>{asset.metadata.title as string}</li>
      ))}
    </ul>
  );
}

// CORRECT — guard on loading and null
function Fixed() {
  const videos = useMediaByIndex("category", "videos");
  if (videos.loading || !videos.data) return <p>Loading…</p>;
  return (
    <ul>
      {videos.data.items.map((asset) => (
        <li key={asset.key}>{asset.metadata.title as string}</li>
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
function Broken({ asset }: { asset: ResolvedMediaAsset }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    fetch(asset.url)
      .then((r) => r.blob())
      .then((b) => setSrc(URL.createObjectURL(b)));
  }, [asset]);
  return <video src={src} />;
}

// CORRECT — pass URL directly to src
function Fixed({ asset }: { asset: ResolvedMediaAsset }) {
  return <video src={asset.url} controls />;
}
```

Source: Maintainer interview

### HIGH: Using removed useMedia hooks

`useMedia({ kind: "item", ... })` and `useMedia({ kind: "list", ... })` were removed in 0.4.0. Use `useMediaAsset` and `useMediaByIndex` instead.

```tsx
// WRONG — removed API
const item = useMedia({ kind: "item", namespace: "videos", id: "welcome" });
const list = useMedia({ kind: "list", namespace: "videos", limit: 20 });

// CORRECT
const asset = useMediaAsset("video/welcome");
const videos = useMediaByIndex("category", "videos", { limit: 20 });
```

Source: `CHANGELOG.md` 0.4.0; `react/index.tsx`

### MEDIUM: Splitting imperative bridge state across multiple hooks

If a component needs `syncNow()`, status, and errors together, prefer `useMediaBridge()` over manually combining separate bridge, status, and error hooks. The combined hook matches the provider runtime and keeps imperative UI code simpler.

```tsx
// WRONG — imperative bridge UI spread across separate hooks
function SyncButton() {
  const status = useMediaCacheStatus();
  const errors = useMediaCacheErrors();
  // some other hook supplies syncNow()
}

// CORRECT — one hook for imperative bridge access
function SyncButton() {
  const { syncNow, status, errors } = useMediaBridge();
  return (
    <button onClick={() => void syncNow()}>
      {status.data?.phase ?? errors.primaryError?.message}
    </button>
  );
}
```

Source: `react/index.tsx` — `useMediaCacheErrors` JSDoc

### MEDIUM: Hardcoding media:// URLs instead of using hook data

URLs differ between offline mode (`media://`) and `devPassthrough` mode (remote HTTPS). Hardcoded URLs break in one of the two modes.

```tsx
// WRONG — hardcoded protocol URL
<video src="media://asset/video%2Fwelcome" />;

// CORRECT — URL from hook result
const { data: asset } = useMediaAsset("video/welcome");
<video src={asset?.url} />;
```

Source: README — devPassthrough documentation

---

See also: getting-started/SKILL.md — Full main → preload → renderer wiring
See also: store-authoring/SKILL.md — Index definitions determine how hooks query content

## References

- [Complete hooks API reference](references/hooks.md)
