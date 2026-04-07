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
  /** Additional structured fields (dimensions, IDs, durations). Values must be JSON-serializable. */
  [key: string]: JsonValue | undefined;
  /** ISO-8601 or high-resolution timestamp string for when the log line was emitted. */
  timestamp: string;
  /** Severity; entries below the effective {@link MediaCacheLoggingOptions.level} are filtered out. */
  level: MediaCacheLogLevel;
  /** Short machine-oriented event name (for example `sync.asset.downloaded`). */
  event: string;
  /** Logical product or app name for log routing. */
  service: string;
  /** Subsystem within the cache (for example `sync`, `protocol`, `database`). */
  component: string;
}

/** Receives log entries from the main-process cache when `logging.onLog` is set on {@link MediaCacheOptions}. */
export type MediaCacheLogHandler = (entry: MediaCacheLogEvent) => void;

/** Logging options when using a custom structured sink. */
export interface MediaCacheCustomLoggingOptions {
  /**
   * Minimum log level emitted; lower-severity lines are dropped.
   * Defaults to `info` when `onLog` is configured.
   */
  level?: MediaCacheLogLevel;
  /** Callback receiving structured {@link MediaCacheLogEvent} lines from the main process. */
  onLog: MediaCacheLogHandler;
  /** Custom log handlers already receive structured events, so console formatting does not apply. */
  format?: never;
}

/** Logging options when using the built-in development console sink. */
export interface MediaCacheConsoleLoggingOptions {
  /**
   * Minimum log level emitted; lower-severity lines are dropped.
   * Defaults to `debug` when the built-in console sink is active.
   */
  level?: MediaCacheLogLevel;
  /**
   * Line format for the built-in console sink only.
   * @default "english"
   */
  format?: MediaCacheLogFormat;
  /** Omit `onLog` to keep the built-in development console sink. */
  onLog?: undefined;
}

/** Logging configuration for `MediaCacheOptions`; custom sinks and console formatting are mutually exclusive. */
export type MediaCacheLoggingOptions =
  | MediaCacheCustomLoggingOptions
  | MediaCacheConsoleLoggingOptions;

/** High-level media category for items and assets in the manifest. */
export type MediaKind = "video" | "image" | "audio" | "document" | "html" | "text" | "binary";

/** Top-level offline manifest: namespaces of content, each with items and downloadable assets. */
export interface MediaCacheManifest {
  /** Optional opaque id for this manifest snapshot (correlation, debugging, or multi-source merges). */
  snapshotId?: string;
  /** Timestamp describing when the manifest payload was retrieved. */
  retrievedAt?: string;
  /**
   * Optional ISO 8601 timestamp after which manifest-derived asset URLs must be treated as expired.
   * Used to fail syncs before opaque late-queue 403s from short-lived pre-signed URLs.
   */
  expiresAt?: string;
  /**
   * Content namespaces keyed by stable namespace id (same string as used in `getItem` / list APIs).
   * Enumeration follows ECMAScript `[[OwnPropertyKeys]]`: non–array-index string keys keep insertion
   * order; keys that are canonical array indices (e.g. `"0"`, `"10"`) are sorted ascending
   * numerically. That order flows into normalization and DB-backed iteration, so avoid
   * numeric-looking ids when you need authoring order to match runtime order (e.g. first asset per role).
   */
  namespaces: Record<string, MediaNamespaceValue>;
}

/**
 * One namespace’s payload for manifest authoring (key is the record key in {@link MediaCacheManifest.namespaces}).
 */
export interface MediaNamespaceValue {
  /** Optional human-readable title for UI (the map key remains the programmatic identifier). */
  label?: string;
  /** App-specific JSON metadata attached to the namespace. */
  metadata?: Record<string, JsonValue>;
  /**
   * Catalog items keyed by stable item id within this namespace.
   * Same `[[OwnPropertyKeys]]` ordering caveats as {@link MediaCacheManifest.namespaces} apply.
   */
  items: Record<string, MediaItemValue>;
}

/**
 * One catalog entry for authoring: human-facing fields plus `assets` that sync downloads to disk.
 * Pass values of this shape to {@link import("../main/producer.js").defineItem}.
 */
export interface MediaItemValue {
  /**
   * Logical content revision (non-empty string). When this changes relative to a previously synced
   * generation, the cache can treat the item as updated and reconcile downloads accordingly.
   */
  version: string;
  /**
   * High-level media category for the item (`video`, `image`, `audio`, etc.). Drives typing in
   * resolved items and helps UIs choose how to present the content.
   */
  kind: MediaKind;
  /** Short human-readable label shown in catalogs or lists. */
  title?: string;
  /** Longer explanatory text for detail views or accessibility. */
  description?: string;
  /** Compact blurb or teaser text when a full description is too long. */
  summary?: string;
  /**
   * Small string key–value payloads stored with the item (JSON-serialized), distinct from binary
   * {@link MediaAssetValue | assets}. Use for inline data such as captions IDs or API hints.
   */
  blobs?: Record<string, string>;
  /**
   * Arbitrary JSON-serializable metadata attached to the item for app-specific use (filters,
   * analytics, feature flags). Surfaces on {@link ResolvedMediaContentItem}.
   */
  metadata?: Record<string, JsonValue>;
  /**
   * Files to fetch and persist for this item, keyed by stable asset id within the item.
   * At least one asset is typical (e.g. primary media).
   * Same `[[OwnPropertyKeys]]` ordering caveats as {@link MediaCacheManifest.namespaces} apply.
   */
  assets: Record<string, MediaAssetValue>;
}

/** One downloadable asset for manifest authoring (id is the record key in {@link MediaItemValue.assets}). */
export interface MediaAssetValue {
  /** Semantic role for consumers (for example `primary`, `poster`, `subtitle`). Indexed on {@link ResolvedMediaContentItem.assetsByRole}. */
  role: string;
  /**
   * Asset kind: core {@link MediaKind} values plus presentation roles (`subtitle`, `caption`,
   * `poster`, `thumbnail`).
   */
  kind: MediaKind | "subtitle" | "caption" | "poster" | "thumbnail";
  /** Optional revision string for this asset when it can change independently of the item `version`. */
  version?: string;
  /** Declared MIME type for serving and media sniffing (for example `video/mp4`). */
  mimeType?: string;
  /**
   * On-disk file name used under the item’s storage folder. If omitted, the implementation may
   * derive a name from the download URL (see {@link import("../main/producer.js").defineAsset}).
   */
  fileName?: string;
  /** Expected size in bytes when known (used for progress and storage planning). */
  byteLength?: number;
  /** Remote URL and optional headers used to fetch bytes during sync (or passthrough in dev). */
  source: MediaRemoteSource;
  /** App-specific JSON metadata for this asset; surfaces on {@link ResolvedMediaAsset}. */
  metadata?: Record<string, JsonValue>;
}

/**
 * Expanded namespace during sync and in {@link ResolveAssetRequestContext} (includes `key` and item array).
 */
export interface SyncManifestNamespace {
  /** Stable namespace identifier used in `getItem`, `listNamespace`, and hierarchical `listNamespaceTree`. */
  key: string;
  label?: string;
  metadata?: Record<string, JsonValue>;
  items: SyncManifestItem[];
}

/**
 * Expanded catalog item during sync (includes `id` and asset array).
 */
export interface SyncManifestItem {
  id: string;
  version: string;
  kind: MediaKind;
  title?: string;
  description?: string;
  summary?: string;
  blobs?: Record<string, string>;
  metadata?: Record<string, JsonValue>;
  assets: SyncManifestAsset[];
}

/** Expanded asset during sync (includes `id`). */
export interface SyncManifestAsset {
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

/** @deprecated Use {@link SyncManifestNamespace} — internal alias for normalized manifest rows. */
export type MediaNamespaceDefinition = SyncManifestNamespace;

/** @deprecated Use {@link SyncManifestItem} — internal alias for normalized manifest rows. */
export type MediaContentDefinition = SyncManifestItem;

/** @deprecated Use {@link SyncManifestAsset} — internal alias for normalized manifest rows. */
export type MediaAssetDefinition = SyncManifestAsset;

/** Remote request template used during sync to fetch an asset (URL plus optional headers). */
export interface MediaRemoteSource {
  /**
   * Absolute URL to download the asset. Query strings and path are treated as part of the resource
   * identity. Runtime validation only accepts `http` and `https` URLs.
   */
  url: string;
  /** HTTP method; only `GET` is supported today. Omit for default GET behavior. */
  method?: "GET";
  /** Optional request headers merged into the download (auth tokens, accepted types, etc.). */
  headers?: Record<string, string>;
}

/** Concrete HTTP request used to download bytes during sync (from manifest or `resolveAssetRequest`). */
export interface DownloadRequest {
  /** Final URL to fetch after any manifest or `resolveAssetRequest` rewriting. */
  url: string;
  /** HTTP method; typically omitted for GET. */
  method?: "GET";
  /** Headers to send with the download request. */
  headers?: Record<string, string>;
}

/** Arguments passed to `resolveAssetRequest` when overriding how an asset is fetched. */
export interface ResolveAssetRequestContext {
  /** Namespace that owns the item being synced. */
  namespace: SyncManifestNamespace;
  /** Manifest item whose asset is being resolved. */
  item: SyncManifestItem;
  /** The specific asset row from the manifest (includes default `source` unless overridden). */
  asset: SyncManifestAsset;
}

/**
 * After a failed sync: keep serving the last committed generation (`serve-last-snapshot`), or
 * propagate the failure (`throw`). Ignored when `devPassthrough` is true (failures always throw).
 */
export type SyncFailureMode = "serve-last-snapshot" | "throw";

/**
 * Allowed `electron.app.getPath(...)` keys for package-managed storage root resolution.
 * Matches Electron's documented `app.getPath` names.
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
  /** Electron well-known directory resolved via `app.getPath(appPath)`. */
  appPath: MediaCacheAppPath;
  /** Path segments joined under that directory to form the cache root. */
  segments?: string[];
}

/**
 * Main-process configuration: where state lives, sync and storage guardrails, logging, and how the
 * manifest and per-asset downloads are resolved.
 *
 * Default behavior is offline mode unless `process.env.NODE_ENV` is `"development"`: assets sync to
 * disk and resolved URLs use the privileged `media:` protocol. Set `devPassthrough: false` to force
 * offline mode even when `NODE_ENV` is `"development"`.
 *
 * **Escape hatch:** set `devPassthrough: true`, or omit it while `NODE_ENV === "development"`, to
 * skip blob downloads and surface direct remote URLs from the manifest (optional `assetBaseUrl`
 * rewrites origins only). When effective `devPassthrough` is `false`, `assetBaseUrl` must not be
 * set. When `logging.onLog` is omitted, human-readable English lines go to the main-process console
 * in non-production `NODE_ENV` (see {@link MediaCacheLoggingOptions.format}). Use `logging.onLog`
 * for a custom sink; use {@link MediaCacheLoggingOptions.level} to filter severity.
 *
 * `MediaCache` requires exclusive ownership of its resolved storage root. In kiosk-style
 * deployments, the first process that acquires that root should win; if startup later fails,
 * callers should reuse that same process/instance or restart the app rather than constructing a
 * replacement cache for the same root. Consumers should also call `app.requestSingleInstanceLock()`
 * early in Electron startup as app-level guidance, but cache-root exclusivity is enforced
 * separately by this package.
 */
export interface MediaCacheOptions {
  /**
   * Storage root resolved from `electron.app.getPath(appPath)` plus optional subpath segments.
   * Consumers must choose one of Electron's well-known roots rather than passing arbitrary paths.
   */
  storagePath: MediaCacheStoragePath;
  /**
   * When `true`, skips downloads and resolves remote asset URLs (advanced / local-dev escape hatch).
   * When omitted, defaults to `true` if `process.env.NODE_ENV === "development"`, otherwise `false`.
   * Set `devPassthrough: false` to preserve offline-mode behavior during development or upgrades.
   */
  devPassthrough?: boolean;
  /**
   * When `devPassthrough` is true: optional origin (or full base URL) used to rewrite asset URLs.
   * Must not be set when offline sync is enabled.
   */
  assetBaseUrl?: string | null;
  /** Soft cap on total bytes of cached asset files; older generations may be pruned to stay under this. */
  maxCacheBytes?: number;
  /** Minimum free disk space to preserve on the volume; sync may refuse work if free space would drop below this. */
  reserveFreeBytes?: number;
  /** After this many milliseconds, assets removed from the manifest may be deleted from disk. */
  staleDeleteAfterMs?: number;
  /** How to behave when a sync fails while a previous generation is still on disk. */
  onSyncFailure?: SyncFailureMode;
  /** Maximum number of completed sync runs to retain in SQLite history. */
  syncHistoryLimit?: number;
  /**
   * Logging configuration. Omit `logging.onLog` to use the built-in development console sink when
   * `NODE_ENV !== "production"` (and `process.env.VITEST !== "true"`). Set `logging.onLog` to
   * receive structured {@link MediaCacheLogEvent} objects in a custom sink instead.
   */
  logging?: MediaCacheLoggingOptions;
  /**
   * Produces the manifest for each sync. May be async.
   * Thrown errors or rejected promises fail the sync run.
   */
  resolveManifest: () => Promise<MediaCacheManifest> | MediaCacheManifest;
  /**
   * Optional per-asset hook to customize URL, method, or headers before download (signing, CDNs, etc.).
   */
  resolveAssetRequest?: (
    ctx: ResolveAssetRequestContext,
  ) => Promise<DownloadRequest> | DownloadRequest;
}

/**
 * Cursor-based page for list APIs. Set `cursor` to the `nextCursor` from a prior
 * {@link PaginationResult} to advance to the next page; omit for the first page.
 */
export interface PaginationInput {
  /** Maximum number of entries to return; implementation-defined default when omitted. */
  limit?: number;
  /** Opaque cursor from a previous page’s `nextCursor`; omit for the first page. */
  cursor?: string;
}

/** One page of results; `nextCursor` is null when there are no more items. */
export interface PaginationResult<T> {
  /** Slice of results for this page. */
  items: T[];
  /** Pass to the next request as `cursor`, or `null` if no further pages exist. */
  nextCursor: string | null;
}

/**
 * Snapshot of sync and readiness: phase, optional in-flight progress, last completed run, and any
 * serialized error from the latest failure.
 */
export interface MediaCacheStatus {
  /** High-level lifecycle: idle, active sync, ready to serve, or terminal error from last run. */
  phase: "idle" | "syncing" | "ready" | "error";
  /** Resolved local storage root where cached blobs and sqlite metadata live. */
  storageRoot: string | null;
  /** Monotonic generation id for the committed snapshot currently active, or `null` before first success. */
  activeGenerationId: number | null;
  /** Live sync progress while `phase === "syncing"`; `null` when no run is in flight. */
  progress: SyncProgress | null;
  /** Most recently completed or in-flight sync run summary from persistence, if any. */
  lastRun: SyncRunSummary | null;
  /** Structured failure from the latest sync attempt; `null` when there is no recorded error. */
  error: SerializedMediaCacheError | null;
  /** `Date.now()` (ms) when this snapshot was produced for subscribers. */
  updatedAt: number;
}

/**
 * UI-facing lifecycle for cache status hooks: includes {@link MediaCacheStatus.phase} plus
 * `"loading"` before the first status snapshot arrives from the bridge.
 */
export type MediaCachePhase = MediaCacheStatus["phase"] | "loading";

/** Fine-grained sync pipeline step and counters while a run is active. */
export interface SyncProgress {
  /** Matches {@link SyncRunSummary.id} for the run this progress describes. */
  runId: number;
  /** Current pipeline stage within a sync run. */
  phase:
    | "resolving-manifest"
    | "staging-generation"
    | "diffing"
    | "downloading"
    | "committing"
    | "pruning";
  /** Total assets scheduled for this run after diffing. */
  totalAssets: number;
  /** Assets that have finished processing (downloaded, skipped, or failed) in this run. */
  completedAssets: number;
  /** Subset of `completedAssets` that required a network download. */
  downloadedAssets: number;
  /** Subset of `completedAssets` satisfied from cache without re-downloading. */
  skippedAssets: number;
  /** Cumulative payload bytes downloaded in this run. */
  bytesDownloaded: number;
}

/** Counters persisted with a {@link SyncRunSummary} after (or during) a sync run. */
export interface SyncRunStats {
  /** Assets considered in the run after manifest diff. */
  totalAssets: number;
  /** Assets fetched over the network in this run. */
  downloadedAssets: number;
  /** Assets reused from disk without download. */
  skippedAssets: number;
  /** Total bytes transferred from remote for this run. */
  bytesDownloaded: number;
}

/** Record of one sync run persisted for history (timing, outcome, and asset stats). */
export interface SyncRunSummary {
  /** Database row id and correlation id for this run. */
  id: number;
  /** Outcome: still running, finished successfully, or finished with error. */
  status: "running" | "success" | "error";
  /** `Date.now()` when the run started. */
  startedAt: number;
  /** `Date.now()` when the run finished, or `null` while `status === "running"`. */
  finishedAt: number | null;
  /** Machine-oriented error code when `status === "error"`; otherwise `null`. */
  errorCode: string | null;
  /** Human-readable error summary when `status === "error"`; otherwise `null`. */
  errorMessage: string | null;
  /** Aggregate asset counts and bytes for this run. */
  stats: SyncRunStats;
}

/**
 * One asset after resolution: same identity and metadata as the manifest, with a `media:` URL for
 * local or passthrough serving.
 */
export interface ResolvedMediaAsset {
  /** Same id as in the manifest {@link MediaAssetDefinition}. */
  id: string;
  /** Same role as in the manifest; use {@link ResolvedMediaContentItem.assetsByRole} for lookup. */
  role: string;
  /** Resolved kind string (manifest kind plus extension roles as stored). */
  kind: string;
  /** MIME type served with this asset, when known. */
  mimeType?: string;
  /** Size on disk or from manifest when available. */
  byteLength?: number;
  /** `media:` URL for offline serving, or remote URL when `devPassthrough` is enabled. */
  url: string;
  /** Normalized metadata map (empty object if the manifest omitted metadata). */
  metadata: Record<string, JsonValue>;
}

/** Fully expanded content item as returned by queries (namespace key, item id, resolved assets). */
export interface ResolvedMediaContentItem {
  /** Namespace key this item was loaded from. */
  namespace: string;
  /** Item id within the namespace. */
  id: string;
  /** Item version string from the manifest. */
  version: string;
  /** Item {@link MediaKind} from the manifest. */
  kind: MediaKind;
  /** Optional title from the manifest. */
  title?: string;
  /** Optional description from the manifest. */
  description?: string;
  /** Optional summary from the manifest. */
  summary?: string;
  /** String map from the manifest; defaults to `{}` when unset. */
  blobs: Record<string, string>;
  /** JSON metadata from the manifest; defaults to `{}` when unset. */
  metadata: Record<string, JsonValue>;
  /** All resolved assets for this item, in manifest order. */
  assets: ResolvedMediaAsset[];
  /**
   * Convenience role index for direct lookup (for example `assetsByRole.primary`).
   * If multiple assets share the same role, the first asset in manifest order wins.
   */
  assetsByRole: Record<string, ResolvedMediaAsset | undefined>;
}

/** Items whose manifest file name stem matched a search, plus which asset ids matched. */
export interface FileStemMatch {
  /** Full resolved item that matched. */
  item: ResolvedMediaContentItem;
  /** Asset ids within that item whose normalized file stem matched the query. */
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
  /** Triggers a sync run (or joins the current one) from renderer code. */
  syncNow(): Promise<void>;
  /**
   * Single item in a namespace, or `null` if missing.
   * @param namespace - Namespace key from the manifest.
   * @param id - Item id within that namespace.
   */
  getItem(namespace: string, id: string): Promise<ResolvedMediaContentItem | null>;
  /**
   * Flat list of items in exactly one namespace, paginated.
   * @param namespace - Namespace key to list.
   * @param pagination - Optional `limit` and `cursor` for the next page.
   */
  listNamespace(
    namespace: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<ResolvedMediaContentItem>>;
  /**
   * Items in the `prefix` namespace and all dot-delimited descendant namespaces (hierarchical browse).
   * @param prefix - Namespace prefix (for example `courses` matches `courses` and `courses.advanced`).
   * @param pagination - Optional `limit` and `cursor` for the next page.
   */
  listNamespaceTree(
    prefix: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<ResolvedMediaContentItem>>;
  /**
   * Search by normalized file name stem; optional `namespace` scopes the search.
   * @param stem - Normalized file stem to match against manifest-derived stems.
   * @param options - Pagination plus optional `namespace` filter.
   */
  findByFileStem(
    stem: string,
    options?: PaginationInput & { namespace?: string },
  ): Promise<PaginationResult<FileStemMatch>>;
  /**
   * Listen for status updates; returns an unsubscribe function.
   * @param listener - Called whenever {@link MediaCacheStatus} changes; keep work cheap.
   */
  subscribeStatus(listener: (status: MediaCacheStatus) => void): () => void;
}

/** Stable error shape stored on {@link MediaCacheStatus} when a sync fails. */
export interface SerializedMediaCacheError {
  /** Error constructor name (for example `SyncFailureError`). */
  name: string;
  /** Stable machine-readable code for branching and logging. */
  code: string;
  /** Human-readable explanation suitable for UI or logs. */
  message: string;
}

/** Options for {@link import("../preload/index.js").exposeMediaCacheBridge}; defaults `key` to `mediaCache` on `window`. */
export interface PreloadExposeOptions {
  /** Global property name on `window` for the bridge (default `mediaCache`). */
  key?: string;
}

/** Optional sync-complete refetch behavior for React query hooks. */
export interface MediaQuerySyncOptions {
  /** When `true`, list/search hooks refetch after a successful sync completes. */
  refetchOnSyncComplete?: boolean;
}

/** Options for list queries in React (`useMedia({ kind: "list", ... })`). */
export interface MediaItemsQueryOptions extends PaginationInput, MediaQuerySyncOptions {
  /** When `true`, list across the namespace tree under the given prefix instead of a single namespace. */
  recursive?: boolean;
}

/** Alias matching the `useMedia({ kind: "list", ... })` API surface. */
export type MediaListQueryOptions = MediaItemsQueryOptions;

/** Options for stem search in React (`useFileStemMatch`). */
export interface FileStemMatchQueryOptions extends PaginationInput, MediaQuerySyncOptions {
  /** If set, only return matches inside this namespace (or its subtree per hook behavior). */
  namespace?: string;
}

/** Derived readiness snapshot for `useMediaCacheReady()`. */
export interface MediaCacheReadyState {
  /** `true` when the cache has completed a successful sync and is serving content. */
  ready: boolean;
  /** `true` while a sync run is actively in progress. */
  syncing: boolean;
  /** Current {@link MediaCacheStatus.phase} mirrored for convenience. */
  phase: MediaCacheStatus["phase"];
  /** Active generation id from status, or `null`. */
  activeGenerationId: number | null;
  /** Last sync error from status, or `null`. */
  syncError: SerializedMediaCacheError | null;
}

/** Aggregated error view for the provider-driven `useMediaCacheErrors()`. */
export interface MediaCacheErrors {
  /** Error serialized from the last failed sync, if any. */
  syncError: SerializedMediaCacheError | null;
  /** Failure loading status from the bridge, if any. */
  statusError: Error | null;
  /** Errors from individual media queries (lists, getItem, search). */
  queryErrors: Error[];
  /** `true` if any of the above are non-null/non-empty. */
  hasError: boolean;
  /** First error the hook considers most relevant for display; sync errors are converted to `Error`. */
  primaryError: Error | null;
}
