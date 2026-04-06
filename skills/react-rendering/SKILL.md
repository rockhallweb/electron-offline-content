---
name: react-rendering
description: >
  React bindings for @rockhallweb/electron-offline-content:
  MediaCacheProvider context, useMedia as the primary query API for
  item and namespace lookups, useMediaBridge and useMediaCacheStatus for sync phase and
  progress, useFileStemMatch for filename search, useMediaCacheReady
  for download gates, and useMediaCacheErrors for aggregated error display.
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
import { useMedia, useMediaCacheReady } from "@rockhallweb/electron-offline-content/react";

function KioskShell() {
  const ready = useMediaCacheReady();
  const videos = useMedia({ kind: "list", namespace: "videos", limit: 50 });

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

### Querying items with useMedia

Returns `UseMediaItemResult` or `UseMediaListResult` depending on whether you pass `{ kind: "item" }` or `{ kind: "list" }`.

Flat namespace query:

```tsx
import { useMedia } from "@rockhallweb/electron-offline-content/react";

function VideoList() {
  const { data, loading, error, refresh } = useMedia({
    kind: "list",
    namespace: "videos",
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
  const { data, loading } = useMedia({
    kind: "list",
    namespace: "exhibits.floor-2",
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

### Single item lookup with useMedia

Use `{ kind: "item", namespace, id }` for an exact item lookup.

```tsx
import { useMedia } from "@rockhallweb/electron-offline-content/react";

function InducteeProfile({ inducteeId }: { inducteeId: string }) {
  const { data: item, loading } = useMedia({
    kind: "item",
    namespace: "inductees",
    id: inducteeId,
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
import { useMedia, useMediaCacheErrors } from "@rockhallweb/electron-offline-content/react";

function ExhibitPage() {
  const videos = useMedia({ kind: "list", namespace: "videos", limit: 50 });
  const images = useMedia({ kind: "list", namespace: "images", limit: 100 });
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
  const items = useMedia({ kind: "list", namespace: "videos" });
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
  const items = useMedia({ kind: "list", namespace: "videos" });
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

### MEDIUM: Using removed `useMediaNamespace` / `useMediaNamespaceTree`

These hooks were removed in 0.2.0. Older snippets or hallucinated names may still reference them.

```tsx
// WRONG — removed API (migrate away)
const items = useMediaNamespace("videos", { limit: 20 });
const tree = useMediaNamespaceTree("exhibits", { limit: 50 });

// CORRECT
const items = useMedia({ kind: "list", namespace: "videos", limit: 20 });
const tree = useMedia({ kind: "list", namespace: "exhibits", recursive: true, limit: 50 });
```

Source: `CHANGELOG.md` 0.2.0; `react/index.tsx` — `useMedia`

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
<video src="media://asset/videos/welcome/main" />;

// CORRECT — URL from hook result
const { data: item } = useMedia({ kind: "item", namespace: "videos", id: "welcome" });
<video src={item?.assetsByRole.primary?.url} />;
```

Source: README — devPassthrough documentation

---

See also: getting-started/SKILL.md — Full main → preload → renderer wiring
See also: manifest-authoring/SKILL.md — Namespace organization determines how hooks query content

## References

- [Complete hooks API reference](references/hooks.md)
