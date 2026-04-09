# Hooks API Reference

Complete reference for the React bindings exported from `@rockhallweb/electron-offline-content/react`.

## Shared Types

### AssetKeyInput

`string | readonly string[]` — pass the same value to `store.add()` in `resolveStore` and to `useMediaAsset()` / `getAsset()`. Non-empty strings or non-empty arrays of non-empty strings are accepted; there is no further key format validation. Arrays are joined with `/` for `displayKey` on resolved assets.

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
  phase: MediaCachePhase;
  errors: MediaCacheErrors;
}
```

**Throws:** if called outside a `MediaCacheProvider`.

```tsx
import { useMediaBridge } from "@rockhallweb/electron-offline-content/react";

function DebugPanel() {
  const { syncNow, status, errors } = useMediaBridge();
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
  phase:
    | "resolving-store"
    | "staging-generation"
    | "diffing"
    | "downloading"
    | "committing"
    | "pruning";
  totalAssets: number;
  completedAssets: number;
  downloadedAssets: number;
  skippedAssets: number;
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

### useMediaAsset

Looks up a single asset by `AssetKeyInput` — the same string or segment array passed as the first argument to `store.add()` in `resolveStore`.

```typescript
function useMediaAsset(
  key: AssetKeyInput,
  options?: { refetchOnSyncComplete?: boolean },
): AsyncState<ResolvedMediaAsset | null>;
```

| Parameter | Type            | Description                                                                 |
| --------- | --------------- | --------------------------------------------------------------------------- |
| `key`     | `AssetKeyInput` | `string` or `readonly string[]` — must match the key used in `store.add()`. |
| `options` | `object`        | Optional. `refetchOnSyncComplete` re-fetches after sync.                    |

**Returns:** `AsyncState<ResolvedMediaAsset | null>`

```tsx
import { useMediaAsset } from "@rockhallweb/electron-offline-content/react";

function WelcomeVideo() {
  const { data: asset, loading } = useMediaAsset(["video", "welcome"]);

  if (loading || !asset) return null;

  return <video src={asset.url} title={asset.displayKey} controls />;
}
```

---

### useMediaByIndex

Queries assets by secondary index: any name passed to `store.defineIndex()` in `resolveStore`, plus the built-in indexes `mimeType` and `mediaKind` that the store adds for every asset.

```typescript
function useMediaByIndex(
  indexName: string,
  value: string,
  options?: {
    limit?: number;
    cursor?: string;
    refetchOnSyncComplete?: boolean;
  },
): AsyncState<PaginationResult<ResolvedMediaAsset>>;
```

| Parameter   | Type     | Description                                        |
| ----------- | -------- | -------------------------------------------------- |
| `indexName` | `string` | Name of the index (as defined by `defineIndex()`). |
| `value`     | `string` | The index value to match.                          |
| `options`   | `object` | Optional pagination and refetch options.           |

**Options:**

| Option                  | Type      | Default | Description                    |
| ----------------------- | --------- | ------- | ------------------------------ |
| `limit`                 | `number`  | —       | Maximum results per page.      |
| `cursor`                | `string`  | —       | Opaque cursor for next page.   |
| `refetchOnSyncComplete` | `boolean` | `true`  | Re-fetch after sync completes. |

**Returns:** `AsyncState<PaginationResult<ResolvedMediaAsset>>`

```tsx
import { useMediaByIndex } from "@rockhallweb/electron-offline-content/react";

function ExhibitList() {
  const { data, loading } = useMediaByIndex("category", "exhibits", {
    limit: 30,
    refetchOnSyncComplete: true,
  });

  if (loading || !data) return <p>Loading…</p>;

  return (
    <>
      {data.items.map((asset) => (
        <div key={asset.key}>
          <img src={asset.url} alt={(asset.metadata.title as string) ?? asset.displayKey} />
        </div>
      ))}
    </>
  );
}
```

---

### useFileStemMatch

Searches cached content by filename stem across all assets.

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

| Option                  | Type      | Default | Description                    |
| ----------------------- | --------- | ------- | ------------------------------ |
| `limit`                 | `number`  | —       | Maximum matches per page.      |
| `cursor`                | `string`  | —       | Opaque cursor for next page.   |
| `refetchOnSyncComplete` | `boolean` | `true`  | Re-fetch after sync completes. |

**Returns:** `AsyncState<PaginationResult<FileStemMatch>>`

```tsx
import { useFileStemMatch } from "@rockhallweb/electron-offline-content/react";

function Search({ query }: { query: string }) {
  const { data, loading } = useFileStemMatch(query, { limit: 20 });

  if (loading || !data) return <p>Searching…</p>;

  return (
    <ul>
      {data.items.map((match) => (
        <li key={match.asset.key}>{match.asset.displayKey}</li>
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
import { useMediaByIndex, useMediaCacheErrors } from "@rockhallweb/electron-offline-content/react";

function Page() {
  const videos = useMediaByIndex("category", "videos");
  const images = useMediaByIndex("category", "images");
  const errors = useMediaCacheErrors();

  if (errors.hasError) {
    return <p>Error: {errors.primaryError?.message}</p>;
  }

  // render content
}
```

---

## Return Types

### ResolvedMediaAsset

A single resolved asset with a ready-to-render URL.

```typescript
interface ResolvedMediaAsset {
  key: string;
  displayKey: string;
  version: string;
  kind: MediaKind;
  mimeType: string;
  byteLength?: number;
  url: string;
  indexes: Record<string, string | string[]>;
  metadata: Record<string, JsonValue>;
}
```

| Field        | Description                                                                      |
| ------------ | -------------------------------------------------------------------------------- |
| `key`        | Stable storage identity (SHA-256–derived hash, 16 hex chars).                    |
| `displayKey` | Original human-readable key (`string` input, or array segments joined with `/`). |
| `version`    | Content version string from the store.                                           |
| `kind`       | Media kind enum value (e.g. `"video"`, `"image"`, `"audio"`, `"document"`).      |
| `mimeType`   | MIME type (e.g. `"video/mp4"`).                                                  |
| `byteLength` | Size in bytes when known from the store.                                         |
| `url`        | Ready-to-render URL. `media://` in offline mode, HTTPS in devPassthrough mode.   |
| `indexes`    | Index names to their values; arrays for multi-cardinality indexes.               |
| `metadata`   | Arbitrary JSON metadata from `store.add()`.                                      |

### FileStemMatch

A filename stem search result.

```typescript
interface FileStemMatch {
  asset: ResolvedMediaAsset;
  score: number;
}
```

| Field   | Description                                              |
| ------- | -------------------------------------------------------- |
| `asset` | The matched `ResolvedMediaAsset`.                        |
| `score` | Relevance score for the match (higher is more relevant). |

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
