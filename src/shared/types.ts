/** JSON-serializable values used in structured logs, metadata, and manifest extras. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Minimum severity emitted when `onLog` is configured; entries below this level are dropped. */
export type MediaCacheLogLevel = "debug" | "info" | "warn" | "error";

/** One structured log line from the cache; includes standard fields plus optional diagnostic keys. */
export interface MediaCacheLogEvent {
  [key: string]: JsonValue | undefined;
  timestamp: string;
  level: MediaCacheLogLevel;
  event: string;
  service: string;
  component: string;
}

/** Receives log entries from the main-process cache when `onLog` is set on {@link MediaCacheOptions}. */
export type MediaCacheLogHandler = (entry: MediaCacheLogEvent) => void;

/** High-level media category for items and assets in the manifest. */
export type MediaKind = "video" | "image" | "audio" | "document" | "html" | "text" | "binary";

/** Top-level offline manifest: namespaces of content, each with items and downloadable assets. */
export interface MediaCacheManifest {
  snapshotId?: string;
  generatedAt?: string;
  namespaces: MediaNamespaceDefinition[];
}

/** A logical bucket of content (e.g. app section); `key` is used in URLs and queries. */
export interface MediaNamespaceDefinition {
  key: string;
  label?: string;
  metadata?: Record<string, JsonValue>;
  items: MediaContentDefinition[];
}

/** One catalog entry: human-facing fields plus `assets` that sync downloads to disk. */
export interface MediaContentDefinition {
  id: string;
  version: string;
  kind: MediaKind;
  title?: string;
  description?: string;
  summary?: string;
  blobs?: Record<string, string>;
  metadata?: Record<string, JsonValue>;
  assets: MediaAssetDefinition[];
}

/** A single downloadable file for a content item; `source` is the remote fetch template. */
export interface MediaAssetDefinition {
  id: string;
  role: string;
  kind: MediaKind | "subtitle" | "caption" | "poster" | "thumbnail";
  version?: string;
  mimeType?: string;
  fileName?: string;
  byteLength?: number;
  source: MediaRemoteSource;
  metadata?: Record<string, JsonValue>;
}

/** Remote request template used during sync to fetch an asset (URL plus optional headers). */
export interface MediaRemoteSource {
  url: string;
  method?: "GET";
  headers?: Record<string, string>;
}

/**
 * Accepted shapes from `MediaCacheOptions.resolveManifest`: full manifest, or a flat list of
 * namespaces or items (normalized into one manifest internally).
 */
export type ManifestInput =
  | MediaCacheManifest
  | MediaNamespaceDefinition[]
  | MediaContentDefinition[];

/** Concrete HTTP request used to download bytes during sync (from manifest or `resolveAssetRequest`). */
export interface DownloadRequest {
  url: string;
  method?: "GET";
  headers?: Record<string, string>;
}

/** Arguments passed to `resolveAssetRequest` when overriding how an asset is fetched. */
export interface ResolveAssetRequestContext {
  namespace: MediaNamespaceDefinition;
  item: MediaContentDefinition;
  asset: MediaAssetDefinition;
}

/**
 * After a failed sync: keep serving the last committed generation (`serve-last-snapshot`), or
 * propagate the failure (`throw`). Ignored when `devPassthrough` is true (failures always throw).
 */
export type SyncFailureMode = "serve-last-snapshot" | "throw";

/**
 * Main-process configuration: where state lives, sync and storage guardrails, logging, and how the
 * manifest and per-asset downloads are resolved. Omit `storageRoot` to use a default app cache path.
 * Set `devPassthrough` to skip downloads and hit `assetBaseUrl` instead; when false, `assetBaseUrl`
 * must not be set. Use `onLog` / `logLevel` for structured diagnostics.
 */
export interface MediaCacheOptions {
  storageRoot?: string;
  devPassthrough?: boolean;
  assetBaseUrl?: string | null;
  maxCacheBytes?: number;
  reserveFreeBytes?: number;
  staleDeleteAfterMs?: number;
  onSyncFailure?: SyncFailureMode;
  syncHistoryLimit?: number;
  logLevel?: MediaCacheLogLevel;
  onLog?: MediaCacheLogHandler;
  resolveManifest: () => Promise<ManifestInput> | ManifestInput;
  resolveAssetRequest?: (
    ctx: ResolveAssetRequestContext,
  ) => Promise<DownloadRequest> | DownloadRequest;
}

/**
 * Cursor-based page for list APIs. Set `cursor` to the `nextCursor` from a prior
 * {@link PaginationResult} to advance to the next page; omit for the first page.
 */
export interface PaginationInput {
  limit?: number;
  cursor?: string;
}

/** One page of results; `nextCursor` is null when there are no more items. */
export interface PaginationResult<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Snapshot of sync and readiness: phase, optional in-flight progress, last completed run, and any
 * serialized error from the latest failure.
 */
export interface MediaCacheStatus {
  phase: "idle" | "syncing" | "ready" | "error";
  activeGenerationId: number | null;
  progress: SyncProgress | null;
  lastRun: SyncRunSummary | null;
  error: SerializedMediaCacheError | null;
  updatedAt: number;
}

/** Fine-grained sync pipeline step and counters while a run is active. */
export interface SyncProgress {
  runId: number;
  phase:
    | "resolving-manifest"
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

/** Record of one sync run persisted for history (timing, outcome, and asset stats). */
export interface SyncRunSummary {
  id: number;
  status: "running" | "success" | "error";
  startedAt: number;
  finishedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  stats: {
    totalAssets: number;
    downloadedAssets: number;
    skippedAssets: number;
    bytesDownloaded: number;
  };
}

/**
 * One asset after resolution: same identity and metadata as the manifest, with a `media:` URL for
 * local or passthrough serving.
 */
export interface ResolvedMediaAsset {
  id: string;
  role: string;
  kind: string;
  mimeType?: string;
  byteLength?: number;
  url: string;
  metadata: Record<string, JsonValue>;
}

/** Fully expanded content item as returned by queries (namespace key, item id, resolved assets). */
export interface ResolvedMediaContentItem {
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
}

/** Items whose manifest file name stem matched a search, plus which asset ids matched. */
export interface FileStemMatch {
  item: ResolvedMediaContentItem;
  matchedAssetIds: string[];
}

/**
 * Renderer-safe API to the cache: same read/query operations as
 * {@link import("../main/media-cache.js").MediaCacheMain}, plus status subscription. Obtained from
 * preload (`exposeMediaCacheBridge`) or passed into React context.
 */
export interface MediaCacheBridge {
  /** Latest status snapshot (phase, progress, last run, error). */
  getStatus(): Promise<MediaCacheStatus>;
  /** Single item in a namespace, or null if missing. */
  getItem(namespace: string, id: string): Promise<ResolvedMediaContentItem | null>;
  /** Flat list of items in exactly one namespace, paginated. */
  listNamespace(
    namespace: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<ResolvedMediaContentItem>>;
  /** Items in any namespace whose key starts with `prefix` (hierarchical browse). */
  listNamespaceTree(
    prefix: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<ResolvedMediaContentItem>>;
  /** Search by normalized file name stem; optional `namespace` scopes the search. */
  findByFileStem(
    stem: string,
    options?: PaginationInput & { namespace?: string },
  ): Promise<PaginationResult<FileStemMatch>>;
  /** Listen for status updates; returns an unsubscribe function. */
  subscribeStatus(listener: (status: MediaCacheStatus) => void): () => void;
}

/** Stable error shape stored on {@link MediaCacheStatus} when a sync fails. */
export interface SerializedMediaCacheError {
  name: string;
  code: string;
  message: string;
}

/** Options for {@link import("../preload/index.js").exposeMediaCacheBridge}; defaults `key` to `mediaCache` on `window`. */
export interface PreloadExposeOptions {
  key?: string;
}
