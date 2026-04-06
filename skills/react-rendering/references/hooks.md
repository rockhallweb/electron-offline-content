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

### useMediaCacheBridge

Low-level access to the underlying bridge instance.

```typescript
function useMediaCacheBridge(): MediaCacheBridge;
```

**Returns:** `MediaCacheBridge` — the bridge instance from context.

**Throws:** if called outside a `MediaCacheProvider`.

```tsx
import { useMediaCacheBridge } from "@rockhallweb/electron-offline-content/react";

function DebugPanel() {
  const bridge = useMediaCacheBridge();
  // Direct bridge method access for advanced use cases
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
function useMediaCacheStatus(): AsyncState<MediaCacheStatus>;
```

**Returns:** `AsyncState<MediaCacheStatus>`

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
  const { data: status } = useMediaCacheStatus();

  if (status?.phase !== "syncing" || !status.progress) return null;

  const pct = Math.round((status.progress.completedAssets / status.progress.totalAssets) * 100);

  return <p>Syncing: {pct}%</p>;
}
```

---

### useMediaItem

Fetches a single cached content item by namespace and id.

```typescript
function useMediaItem(
  namespace: string,
  id: string,
  options?: MediaQuerySyncOptions,
): AsyncState<ResolvedMediaContentItem | null>;
```

| Parameter   | Type                                 | Description                                                |
| ----------- | ------------------------------------ | ---------------------------------------------------------- |
| `namespace` | `string`                             | Content namespace (e.g. `"videos"`, `"exhibits/floor-1"`). |
| `id`        | `string`                             | Unique item identifier within the namespace.               |
| `options`   | `MediaQuerySyncOptions \| undefined` | Optional. Sync-related options.                            |

**MediaQuerySyncOptions:**

| Option                  | Type      | Default | Description                                             |
| ----------------------- | --------- | ------- | ------------------------------------------------------- |
| `refetchOnSyncComplete` | `boolean` | `false` | Re-fetch automatically when a sync operation completes. |

**Returns:** `AsyncState<ResolvedMediaContentItem | null>` — `null` when the item does not exist.

```tsx
import { useMediaItem } from "@rockhallweb/electron-offline-content/react";

function WelcomeVideo() {
  const { data: item, loading } = useMediaItem("videos", "welcome", {
    refetchOnSyncComplete: true,
  });

  if (loading || !item) return null;

  return (
    <video src={item.assetsByRole.primary?.url} poster={item.assetsByRole.poster?.url} controls />
  );
}
```

---

### useMediaItems

Paginated query for items within a namespace or namespace prefix.

```typescript
function useMediaItems(
  namespaceOrPrefix: string,
  options?: MediaItemsQueryOptions,
): AsyncState<PaginationResult<ResolvedMediaContentItem>>;
```

| Parameter           | Type                                  | Description                                                               |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `namespaceOrPrefix` | `string`                              | Exact namespace for flat queries, or a prefix when `recursive` is `true`. |
| `options`           | `MediaItemsQueryOptions \| undefined` | Pagination and behavior options.                                          |

**MediaItemsQueryOptions:**

| Option                  | Type      | Default | Description                                                 |
| ----------------------- | --------- | ------- | ----------------------------------------------------------- |
| `limit`                 | `number`  | —       | Maximum items to return per page.                           |
| `cursor`                | `string`  | —       | Opaque cursor for fetching the next page.                   |
| `recursive`             | `boolean` | `false` | When `true`, queries all namespaces under the given prefix. |
| `refetchOnSyncComplete` | `boolean` | `false` | Re-fetch automatically when a sync completes.               |

**Returns:** `AsyncState<PaginationResult<ResolvedMediaContentItem>>`

`PaginationResult<T>` contains `{ items: T[], cursor?: string }`.

```tsx
import { useMediaItems } from "@rockhallweb/electron-offline-content/react";

function ExhibitList() {
  const { data, loading } = useMediaItems("exhibits", {
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
        <li key={`${match.namespace}/${match.id}`}>
          {match.namespace}/{match.id}
        </li>
      ))}
    </ul>
  );
}
```

---

### useMediaCacheErrors

Aggregates errors from a shared status subscription and any number of query hook states.

```typescript
function useMediaCacheErrors(
  status: MediaCacheStatusState,
  ...queryStates: Array<{ error: Error | null }>
): MediaCacheErrors;
```

| Parameter        | Type                              | Description                                                                           |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `status`         | `MediaCacheStatusState`           | Return value of `useMediaCacheStatus()`. Shared to avoid duplicate IPC subscriptions. |
| `...queryStates` | `Array<{ error: Error \| null }>` | Spread of any hook return values that have an `error` field.                          |

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
| `syncError`    | Error from the sync process itself (from `status.data.error`).                             |
| `statusError`  | Error fetching status (from `status.error`).                                               |
| `queryErrors`  | Array of non-null errors from the provided query states.                                   |
| `hasError`     | `true` if any of the above are set.                                                        |
| `primaryError` | First available error in priority order: `syncError` → `statusError` → first `queryError`. |

```tsx
import {
  useMediaCacheStatus,
  useMediaItems,
  useMediaCacheErrors,
} from "@rockhallweb/electron-offline-content/react";

function Page() {
  const status = useMediaCacheStatus();
  const videos = useMediaItems("videos");
  const images = useMediaItems("images");

  const errors = useMediaCacheErrors(status, videos, images);

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
