# Hooks API Reference

Complete reference for the React bindings exported from `@rockhallweb/electron-offline-content/react`.

## Shared Types

### AsyncState\<T\>

Every data-fetching hook returns this shape:

```typescript
interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}
```

- `data` — `null` until the first successful load, then `T`.
- `loading` — `true` during initial fetch and during `refresh()`.
- `error` — Set when the underlying IPC call fails; `null` otherwise.
- `refresh()` — Re-fetches data from the bridge. Returns a promise that resolves when the fetch completes.

### MediaCacheProvider

Context provider that supplies the `MediaCacheBridge` to all hooks.

```typescript
function MediaCacheProvider({
  bridge,
  children,
}: PropsWithChildren<{ bridge?: MediaCacheBridge }>): JSX.Element;
```

| Prop       | Type                            | Description                                                                              |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `bridge`   | `MediaCacheBridge \| undefined` | Optional explicit bridge instance. When omitted, auto-detected from `window.mediaCache`. |
| `children` | `ReactNode`                     | Application tree.                                                                        |

```tsx
import { MediaCacheProvider } from "@rockhallweb/electron-offline-content/react";

<MediaCacheProvider>
  <App />
</MediaCacheProvider>;
```

---

## Hooks

### useMediaBridge

Low-level access to the underlying bridge methods with shared status and aggregated errors.

```typescript
function useMediaBridge(): UseMediaBridgeResult;
```

**Returns:** `UseMediaBridgeResult`

```typescript
interface UseMediaBridgeResult extends MediaCacheBridge {
  status: AsyncState<MediaCacheStatus>;
  errors: MediaCacheErrors;
}
```

**Throws:** if called outside a `MediaCacheProvider`.

```tsx
import { useMediaBridge } from "@rockhallweb/electron-offline-content/react";

function DebugPanel() {
  const { syncNow, status, errors } = useMediaBridge();
  // Direct bridge methods with status + errors bundled together
}
```

---

### useMediaCacheReady

Reports whether cached content is available for rendering.

```typescript
function useMediaCacheReady(): AsyncState<MediaCacheReadyState>;
```

**Returns:** `AsyncState<MediaCacheReadyState>`

```typescript
interface MediaCacheReadyState {
  ready: boolean;
  syncing: boolean;
  phase: "idle" | "syncing" | "ready" | "error";
  activeGenerationId: string | null;
  syncError: Error | null;
}
```

| Field                | Description                                                                      |
| -------------------- | -------------------------------------------------------------------------------- |
| `ready`              | `true` once at least one successful sync has completed and content is available. |
| `syncing`            | `true` while a sync operation is in progress.                                    |
| `phase`              | Current sync lifecycle phase.                                                    |
| `activeGenerationId` | ID of the current content generation, or `null` before first sync.               |
| `syncError`          | Error from the most recent sync attempt, or `null`.                              |

```tsx
import { useMediaCacheReady } from "@rockhallweb/electron-offline-content/react";

function Gate({ children }: { children: React.ReactNode }) {
  const { data, loading } = useMediaCacheReady();

  if (loading || !data?.ready) {
    return <p>{data?.syncing ? "Downloading…" : "Preparing…"}</p>;
  }

  return <>{children}</>;
}
```

---

### useMediaCacheStatus

Detailed sync status including progress counters.

```typescript
function useMediaCacheStatus(): UseMediaCacheStatusResult;
```

**Returns:** `UseMediaCacheStatusResult` — `AsyncState<MediaCacheStatus>` fields plus top-level `phase: MediaCachePhase` (`"loading"` until the first snapshot, then the cache phase).

```typescript
interface MediaCacheStatus {
  phase: "idle" | "syncing" | "ready" | "error";
  storageRoot: string;
  activeGenerationId: string | null;
  progress: SyncProgress | null;
  lastRun: string | null;
  error: string | null;
}

interface SyncProgress {
  totalAssets: number;
  completedAssets: number;
  bytesDownloaded: number;
}
```

| Field                | Description                                                      |
| -------------------- | ---------------------------------------------------------------- |
| `phase`              | Current sync lifecycle phase.                                    |
| `storageRoot`        | Absolute path to the local cache directory.                      |
| `activeGenerationId` | ID of the content generation being served.                       |
| `progress`           | Asset-level progress during `"syncing"` phase; `null` otherwise. |
| `lastRun`            | ISO timestamp of the last completed sync, or `null`.             |
| `error`              | Error message string from the last sync failure, or `null`.      |

```tsx
import { useMediaCacheStatus } from "@rockhallweb/electron-offline-content/react";

function SyncProgress() {
  const { data: status, phase } = useMediaCacheStatus();

  if (phase !== "syncing" || !status?.progress) return null;

  const pct = Math.round((status.progress.completedAssets / status.progress.totalAssets) * 100);

  return <p>Syncing: {pct}%</p>;
}
```

---

### useMedia

Primary query hook for item and namespace lookups.

```typescript
function useMedia(
  options:
    | { kind: "item"; namespace: string; id: string; refetchOnSyncComplete?: boolean }
    | {
        kind: "list";
        namespace: string;
        recursive?: boolean;
        limit?: number;
        cursor?: string;
        refetchOnSyncComplete?: boolean;
      },
): UseMediaItemResult | UseMediaListResult;
```

**Item example:**

```tsx
import { useMedia } from "@rockhallweb/electron-offline-content/react";

function WelcomeVideo() {
  const { data: item, loading } = useMedia({
    kind: "item",
    namespace: "videos",
    id: "welcome",
    refetchOnSyncComplete: true,
  });

  if (loading || !item) return null;

  return (
    <video src={item.assetsByRole.primary?.url} poster={item.assetsByRole.poster?.url} controls />
  );
}
```

---

**List example:**

```tsx
import { useMedia } from "@rockhallweb/electron-offline-content/react";

function ExhibitList() {
  const { data, loading } = useMedia({
    kind: "list",
    namespace: "exhibits",
    limit: 30,
    recursive: true,
    refetchOnSyncComplete: true,
  });

  if (loading || !data) return <p>Loading…</p>;

  return (
    <>
      {data.items.map((item) => (
        <div key={`${item.namespace}/${item.id}`}>
          <img src={item.assetsByRole.thumbnail?.url} alt={item.title} />
        </div>
      ))}
    </>
  );
}
```

---

### useFileStemMatch

Searches cached content by filename stem, optionally filtered to a namespace.

```typescript
function useFileStemMatch(
  stem: string,
  options?: FileStemMatchQueryOptions,
): AsyncState<PaginationResult<FileStemMatch>>;
```

| Parameter | Type                                     | Description                                      |
| --------- | ---------------------------------------- | ------------------------------------------------ |
| `stem`    | `string`                                 | Filename stem to search for (without extension). |
| `options` | `FileStemMatchQueryOptions \| undefined` | Filtering and pagination options.                |

**FileStemMatchQueryOptions:**

| Option                  | Type      | Default | Description                              |
| ----------------------- | --------- | ------- | ---------------------------------------- |
| `limit`                 | `number`  | —       | Maximum matches per page.                |
| `cursor`                | `string`  | —       | Opaque cursor for next page.             |
| `namespace`             | `string`  | —       | Restrict search to a specific namespace. |
| `refetchOnSyncComplete` | `boolean` | `false` | Re-fetch after sync completes.           |

**Returns:** `AsyncState<PaginationResult<FileStemMatch>>`

```tsx
import { useFileStemMatch } from "@rockhallweb/electron-offline-content/react";

function Search({ query }: { query: string }) {
  const { data, loading } = useFileStemMatch(query, {
    limit: 20,
    namespace: "exhibits",
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

---

### useMediaCacheErrors

Aggregates sync errors and provider-wide query errors without requiring caller arguments.

```typescript
function useMediaCacheErrors(): MediaCacheErrors;
```

**Returns:** `MediaCacheErrors`

```typescript
interface MediaCacheErrors {
  syncError: Error | null;
  statusError: Error | null;
  queryErrors: Error[];
  hasError: boolean;
  primaryError: Error | null;
}
```

| Field          | Description                                                                                |
| -------------- | ------------------------------------------------------------------------------------------ |
| `syncError`    | Error from the sync process itself (from the shared provider status).                      |
| `statusError`  | Error fetching status.                                                                     |
| `queryErrors`  | Array of non-null errors from mounted query hooks under the same `MediaCacheProvider`.     |
| `hasError`     | `true` if any of the above are set.                                                        |
| `primaryError` | First available error in priority order: `statusError` → first `queryError` → `syncError`. |

```tsx
import { useMedia, useMediaCacheErrors } from "@rockhallweb/electron-offline-content/react";

function Page() {
  const videos = useMedia({ kind: "list", namespace: "videos" });
  const images = useMedia({ kind: "list", namespace: "images" });
  const errors = useMediaCacheErrors();

  if (errors.hasError) {
    return <p>Error: {errors.primaryError?.message}</p>;
  }

  // render content
}
```

---

## Return Types

### ResolvedMediaContentItem

Fully resolved content item with local/remote URLs for all assets.

```typescript
interface ResolvedMediaContentItem {
  namespace: string;
  id: string;
  version: string;
  kind: MediaKind;
  title?: string;
  description?: string;
  summary?: string;
  blobs: Record<string, string>;
  metadata: Record<string, JsonValue>;
  assets: ResolvedMediaAsset[];
  assetsByRole: Record<string, ResolvedMediaAsset | undefined>;
}
```

| Field          | Description                                                                         |
| -------------- | ----------------------------------------------------------------------------------- |
| `namespace`    | Namespace the item belongs to.                                                      |
| `id`           | Unique identifier within the namespace.                                             |
| `version`      | Content version string from the manifest.                                           |
| `kind`         | Media kind enum value.                                                              |
| `title`        | Optional display title.                                                             |
| `description`  | Optional long description.                                                          |
| `summary`      | Optional short summary.                                                             |
| `blobs`        | Key-value map of inline blob data.                                                  |
| `metadata`     | Arbitrary JSON metadata from the manifest.                                          |
| `assets`       | Ordered array of all resolved assets.                                               |
| `assetsByRole` | Convenience lookup: asset `role` → `ResolvedMediaAsset`. First asset per role wins. |

### ResolvedMediaAsset

A single resolved asset with a ready-to-render URL.

```typescript
interface ResolvedMediaAsset {
  id: string;
  role: string;
  kind: string;
  mimeType?: string;
  byteLength?: number;
  url: string;
  metadata: Record<string, JsonValue>;
}
```

| Field        | Description                                                                    |
| ------------ | ------------------------------------------------------------------------------ |
| `id`         | Unique asset identifier.                                                       |
| `role`       | Semantic role (e.g. `"primary"`, `"poster"`, `"thumbnail"`, `"captions"`).     |
| `kind`       | Asset kind (e.g. `"video"`, `"image"`, `"audio"`, `"document"`).               |
| `mimeType`   | MIME type when known (e.g. `"video/mp4"`).                                     |
| `byteLength` | File size in bytes when known.                                                 |
| `url`        | Ready-to-render URL. `media://` in offline mode, HTTPS in devPassthrough mode. |
| `metadata`   | Arbitrary JSON metadata for this asset.                                        |

### MediaCacheReadyState

```typescript
interface MediaCacheReadyState {
  ready: boolean;
  syncing: boolean;
  phase: "idle" | "syncing" | "ready" | "error";
  activeGenerationId: string | null;
  syncError: Error | null;
}
```

### MediaCacheErrors

```typescript
interface MediaCacheErrors {
  syncError: Error | null;
  statusError: Error | null;
  queryErrors: Error[];
  hasError: boolean;
  primaryError: Error | null;
}
```
