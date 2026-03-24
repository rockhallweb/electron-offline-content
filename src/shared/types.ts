export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MediaCacheLogLevel = "debug" | "info" | "warn" | "error";

export interface MediaCacheLogEvent {
  [key: string]: JsonValue | undefined;
  timestamp: string;
  level: MediaCacheLogLevel;
  event: string;
  service: string;
  component: string;
}

export type MediaCacheLogHandler = (entry: MediaCacheLogEvent) => void;

export type MediaKind = "video" | "image" | "audio" | "document" | "html" | "text" | "binary";

export interface MediaCacheManifest {
  snapshotId?: string;
  generatedAt?: string;
  namespaces: MediaNamespaceDefinition[];
}

export interface MediaNamespaceDefinition {
  key: string;
  label?: string;
  metadata?: Record<string, JsonValue>;
  items: MediaContentDefinition[];
}

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

export interface MediaRemoteSource {
  url: string;
  method?: "GET";
  headers?: Record<string, string>;
}

export type ManifestInput =
  | MediaCacheManifest
  | MediaNamespaceDefinition[]
  | MediaContentDefinition[];

export interface DownloadRequest {
  url: string;
  method?: "GET";
  headers?: Record<string, string>;
}

export interface ResolveAssetRequestContext {
  namespace: MediaNamespaceDefinition;
  item: MediaContentDefinition;
  asset: MediaAssetDefinition;
}

export type SyncFailureMode = "serve-last-snapshot" | "throw";

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

export interface PaginationInput {
  limit?: number;
  cursor?: string;
}

export interface PaginationResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MediaCacheStatus {
  phase: "idle" | "syncing" | "ready" | "error";
  activeGenerationId: number | null;
  progress: SyncProgress | null;
  lastRun: SyncRunSummary | null;
  error: SerializedMediaCacheError | null;
  updatedAt: number;
}

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

export interface ResolvedMediaAsset {
  id: string;
  role: string;
  kind: string;
  mimeType?: string;
  byteLength?: number;
  url: string;
  metadata: Record<string, JsonValue>;
}

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

export interface FileStemMatch {
  item: ResolvedMediaContentItem;
  matchedAssetIds: string[];
}

export interface MediaCacheBridge {
  getStatus(): Promise<MediaCacheStatus>;
  getItem(namespace: string, id: string): Promise<ResolvedMediaContentItem | null>;
  listNamespace(
    namespace: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<ResolvedMediaContentItem>>;
  listNamespaceTree(
    prefix: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<ResolvedMediaContentItem>>;
  findByFileStem(
    stem: string,
    options?: PaginationInput & { namespace?: string },
  ): Promise<PaginationResult<FileStemMatch>>;
  subscribeStatus(listener: (status: MediaCacheStatus) => void): () => void;
}

export interface SerializedMediaCacheError {
  name: string;
  code: string;
  message: string;
}

export interface PreloadExposeOptions {
  key?: string;
}
