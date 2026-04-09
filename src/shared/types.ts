/** JSON-serializable values used in structured logs, metadata, and manifest extras. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Minimum severity emitted when logging is configured; entries below this level are dropped. */
export type MediaCacheLogLevel = "debug" | "info" | "warn" | "error";

/**
 * How the built-in main-process console sink formats each line when `logging.onLog` is omitted.
 * Callback loggers always receive structured {@link MediaCacheLogEvent} objects regardless of this setting.
 */
export type MediaCacheLogFormat = "english" | "json";

/** One structured log line from the cache; includes standard fields plus optional diagnostic keys. */
export interface MediaCacheLogEvent {
  [key: string]: JsonValue | undefined;
  timestamp: string;
  level: MediaCacheLogLevel;
  event: string;
  service: string;
  component: string;
}

/** Receives log entries from the main-process cache when `logging.onLog` is set on {@link MediaCacheOptions}. */
export type MediaCacheLogHandler = (entry: MediaCacheLogEvent) => void;

/** Logging options when using a custom structured sink. */
export interface MediaCacheCustomLoggingOptions {
  level?: MediaCacheLogLevel;
  onLog: MediaCacheLogHandler;
  format?: never;
}

/** Logging options when using the built-in development console sink. */
export interface MediaCacheConsoleLoggingOptions {
  level?: MediaCacheLogLevel;
  format?: MediaCacheLogFormat;
  onLog?: undefined;
}

/** Logging configuration for `MediaCacheOptions`; custom sinks and console formatting are mutually exclusive. */
export type MediaCacheLoggingOptions =
  | MediaCacheCustomLoggingOptions
  | MediaCacheConsoleLoggingOptions;

/** High-level media category derived from an asset's mimeType. */
export type MediaKind = "video" | "image" | "audio" | "document" | "html" | "text" | "binary";

/** Accepted asset key input: a plain string or an array of string segments. */
export type AssetKeyInput = string | readonly string[];

/** Tagged index entry produced by calling a {@link import("../main/store.js").MediaIndex} handle. */
export class IndexTag {
  constructor(
    readonly name: string,
    readonly value: string | string[],
  ) {}
}

/** Input for adding an asset to a {@link import("../main/store.js").MediaStore}. */
export interface MediaAssetInput {
  version: string;
  mimeType: string;
  url: string;
  fileName?: string;
  /**
   * Optional declared size in bytes. When set, must be a **non-negative finite** number
   * (`Number.isFinite` and `>= 0`). **Fractional values are allowed** (e.g. estimates);
   * the store does not require integers.
   */
  byteLength?: number;
  metadata?: Record<string, JsonValue>;
  indexes?: IndexTag[];
}

/** Describes one user-defined or built-in index in the serialized store output. */
export interface IndexDefinition {
  name: string;
  cardinality: "single" | "multi";
  required: boolean;
  builtin: boolean;
}

/** One asset in the serialized flat manifest (output of `MediaStore._serialize()`). */
export interface FlatManifestAsset {
  key: string;
  displayKey: string;
  version: string;
  mimeType: string;
  mediaKind: MediaKind;
  url: string;
  fileName: string;
  fileStem: string;
  byteLength?: number;
  metadata: Record<string, JsonValue>;
  indexes: Record<string, string | string[]>;
}

/** Serialized flat manifest produced by `MediaStore._serialize()` and consumed by the sync engine. */
export interface FlatManifest {
  snapshotId?: string;
  retrievedAt?: string;
  expiresAt?: string;
  indexDefinitions: IndexDefinition[];
  assets: FlatManifestAsset[];
}

/**
 * After a failed sync: keep serving the last committed generation (`serve-last-snapshot`), or
 * propagate the failure (`throw`). Ignored when `devPassthrough` is true (failures always throw).
 */
export type SyncFailureMode = "serve-last-snapshot" | "throw";

/**
 * Allowed `electron.app.getPath(...)` keys for package-managed storage root resolution.
 */
export type MediaCacheAppPath =
  | "home"
  | "appData"
  | "userData"
  | "sessionData"
  | "temp"
  | "exe"
  | "module"
  | "desktop"
  | "documents"
  | "downloads"
  | "music"
  | "pictures"
  | "videos"
  | "recent"
  | "logs"
  | "crashDumps";

/** Storage root composed from `electron.app.getPath(appPath)` plus optional subpath segments. */
export interface MediaCacheStoragePath {
  appPath: MediaCacheAppPath;
  segments?: string[];
}

/**
 * Main-process configuration: where state lives, sync and storage guardrails, logging, and how the
 * store is resolved.
 *
 * Default behavior is offline mode unless `process.env.NODE_ENV` is `"development"`: assets sync to
 * disk and resolved URLs use the privileged `media:` protocol.
 */
export interface MediaCacheOptions {
  storagePath: MediaCacheStoragePath;
  devPassthrough?: boolean;
  assetBaseUrl?: string | null;
  maxCacheBytes?: number;
  reserveFreeBytes?: number;
  staleDeleteAfterMs?: number;
  onSyncFailure?: SyncFailureMode;
  syncHistoryLimit?: number;
  logging?: MediaCacheLoggingOptions;
  resolveStore: () =>
    | Promise<import("../main/store.js").MediaStore>
    | import("../main/store.js").MediaStore;
}

/** Cursor-based page for list APIs. */
export interface PaginationInput {
  limit?: number;
  cursor?: string;
}

/** One page of results; `nextCursor` is null when there are no more items. */
export interface PaginationResult<T> {
  items: T[];
  nextCursor: string | null;
}

/** Snapshot of sync and readiness state. */
export interface MediaCacheStatus {
  phase: "idle" | "syncing" | "ready" | "error";
  storageRoot: string | null;
  activeGenerationId: number | null;
  progress: SyncProgress | null;
  lastRun: SyncRunSummary | null;
  error: SerializedMediaCacheError | null;
  updatedAt: number;
}

export type MediaCachePhase = MediaCacheStatus["phase"] | "loading";

/** Fine-grained sync pipeline step and counters while a run is active. */
export interface SyncProgress {
  runId: number;
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

/** Counters persisted with a {@link SyncRunSummary} after (or during) a sync run. */
export interface SyncRunStats {
  totalAssets: number;
  downloadedAssets: number;
  skippedAssets: number;
  bytesDownloaded: number;
}

/** Record of one sync run persisted for history. */
export interface SyncRunSummary {
  id: number;
  status: "running" | "success" | "error";
  startedAt: number;
  finishedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  stats: SyncRunStats;
}

/** One asset after resolution: flat key-value with `media:` URL or remote URL in passthrough mode. */
export interface ResolvedMediaAsset {
  key: string;
  displayKey: string;
  version: string;
  mimeType: string;
  kind: MediaKind;
  byteLength?: number;
  url: string;
  metadata: Record<string, JsonValue>;
  indexes: Record<string, string | string[]>;
}

/** Assets whose manifest file name stem matched a search. */
export interface FileStemMatch {
  asset: ResolvedMediaAsset;
}

/**
 * Renderer-safe API to the cache: read/query operations plus status subscription.
 */
export interface MediaCacheBridge {
  getStatus(): Promise<MediaCacheStatus>;
  syncNow(): Promise<void>;
  getAsset(key: AssetKeyInput): Promise<ResolvedMediaAsset | null>;
  listByIndex(
    indexName: string,
    value: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<ResolvedMediaAsset>>;
  findByFileStem(
    stem: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<FileStemMatch>>;
  subscribeStatus(listener: (status: MediaCacheStatus) => void): () => void;
}

/** Stable error shape stored on {@link MediaCacheStatus} when a sync fails. */
export interface SerializedMediaCacheError {
  name: string;
  code: string;
  message: string;
}

/** Options for {@link import("../preload/index.js").exposeMediaCacheBridge}. */
export interface PreloadExposeOptions {
  key?: string;
}

/** Optional sync-complete refetch behavior for React query hooks. */
export interface MediaQuerySyncOptions {
  refetchOnSyncComplete?: boolean;
}

/** Derived readiness snapshot for `useMediaCacheReady()`. */
export interface MediaCacheReadyState {
  ready: boolean;
  syncing: boolean;
  phase: MediaCacheStatus["phase"];
  activeGenerationId: number | null;
  syncError: SerializedMediaCacheError | null;
}

/** Aggregated error view for the provider-driven `useMediaCacheErrors()`. */
export interface MediaCacheErrors {
  syncError: SerializedMediaCacheError | null;
  statusError: Error | null;
  queryErrors: Error[];
  hasError: boolean;
  primaryError: Error | null;
}
