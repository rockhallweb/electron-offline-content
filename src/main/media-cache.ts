import { EventEmitter } from "node:events";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { statfs, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IpcMain, Session } from "electron";
import { MEDIA_CACHE_IPC } from "../shared/ipc.js";
import { normalizeManifest, type NormalizedManifest } from "../shared/normalize.js";
import { normalizeStem } from "../shared/stem.js";
import {
  DataValidationError,
  ManifestValidationError,
  StorageLimitError,
  SyncFailureError,
  isNoSpaceError,
  toSerializedError,
} from "../shared/errors.js";
import type {
  DownloadRequest,
  JsonValue,
  MediaCacheBridge,
  MediaCacheLogEvent,
  MediaCacheLogLevel,
  MediaCacheOptions,
  MediaCacheStatus,
  PaginationInput,
  ResolvedMediaContentItem,
  SyncProgress,
} from "../shared/types.js";
import {
  optionalFindByFileStemOptionsSchema,
  optionalPaginationInputSchema,
  parseWithSchema,
  stringInputSchema,
} from "../internal/validation.js";
import { MediaCacheDatabase, type SyncRunStats } from "./database.js";
import { consoleWarnResolveAssetBaseUrlFallback } from "../internal/url-warn.js";
import { defaultStorageRoot } from "./default-storage.js";

const requireElectron = createRequire(import.meta.url);

const DEFAULT_STALE_DELETE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SYNC_HISTORY_LIMIT = 50;
const LOG_LEVEL_WEIGHT: Record<MediaCacheLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let mediaCacheProtocolSchemesPrivileged = false;

function isModuleNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
  );
}

/**
 * Registers the privileged `media:` scheme once per process. Call happens when constructing
 * {@link MediaCache} in offline mode so consumers do not need a separate bootstrap step.
 *
 * No-ops when `electron` cannot be loaded (e.g. unit tests outside Electron). When Electron is
 * available, failures from `protocol.registerSchemesAsPrivileged` propagate (including calling
 * too late after `app.ready`).
 */
function ensureMediaCacheProtocolSchemesPrivileged(): void {
  if (mediaCacheProtocolSchemesPrivileged) {
    return;
  }

  let protocol: import("electron").Protocol;
  try {
    ({ protocol } = requireElectron("electron") as typeof import("electron"));
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      return;
    }
    throw error;
  }

  if (protocol == null || typeof protocol.registerSchemesAsPrivileged !== "function") {
    return;
  }

  protocol.registerSchemesAsPrivileged([
    {
      scheme: "media",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
  mediaCacheProtocolSchemesPrivileged = true;
}

/**
 * Clears the internal `media:` scheme registration flag so subsequent {@link MediaCache}
 * construction runs registration again. **Unit tests only**; do not use in application code.
 * @internal
 */
export function resetMediaCacheProtocolRegistrationStateForTests(): void {
  mediaCacheProtocolSchemesPrivileged = false;
}

interface DownloadTarget {
  namespace: string;
  itemId: string;
  assetId: string;
  request: DownloadRequest;
  fileName: string;
  resolvedVersion: string;
  byteLength?: number;
}

interface RuntimeDependencies {
  fetchImpl: typeof globalThis.fetch;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
}

interface RegisterProtocolOptions {
  session?: Session;
  fetchFile?: (request: Request, filePath: string) => Promise<Response>;
}

interface AttachIpcOptions {
  ipcMain?: IpcMain;
}

/**
 * Main-process controller: syncs the manifest, stores blobs, serves `media:` URLs, and can expose
 * the same operations to renderers via IPC. In offline mode (default), construct the cache before
 * `app.whenReady()` so the privileged `media:` scheme can be registered, then after ready call
 * {@link MediaCacheMain.registerProtocol}, `attachIpc`, and `start` (or `syncNow`).
 */
export interface MediaCacheMain {
  /** Initializes storage, then runs an initial sync (same as calling `syncNow` after init). */
  start(): Promise<void>;
  /** Runs or joins the current sync; concurrent callers share one run. */
  syncNow(): Promise<void>;
  /** Latest status snapshot (phase, progress, last run, error). */
  getStatus(): Promise<MediaCacheStatus>;
  /** Single item in a namespace, or null if missing. */
  getItem(namespace: string, id: string): Promise<ResolvedMediaContentItem | null>;
  /** Flat list of items in exactly one namespace, paginated. */
  listNamespace(
    namespace: string,
    pagination?: PaginationInput,
  ): Promise<{ items: ResolvedMediaContentItem[]; nextCursor: string | null }>;
  /** Items in the `prefix` namespace and all dot-delimited descendant namespaces (hierarchical browse). */
  listNamespaceTree(
    prefix: string,
    pagination?: PaginationInput,
  ): Promise<{ items: ResolvedMediaContentItem[]; nextCursor: string | null }>;
  /** Search by normalized file name stem; optional `namespace` scopes the search. */
  findByFileStem(
    stem: string,
    options?: PaginationInput & { namespace?: string },
  ): Promise<Awaited<ReturnType<MediaCacheBridge["findByFileStem"]>>>;
  /** Register the `media:` protocol handler for the given session (default: `defaultSession`). */
  registerProtocol(options?: RegisterProtocolOptions): Promise<void>;
  /** Wire `ipcMain` handlers and broadcast status to all browser windows. */
  attachIpc(options?: AttachIpcOptions): Promise<void>;
}

/** Constructs a {@link MediaCacheMain} instance with the given options (does not start sync until `start` or `syncNow`). */
export function createMediaCache(options: MediaCacheOptions): MediaCacheMain {
  return new MediaCache(options);
}

export class MediaCache implements MediaCacheMain {
  private readonly events = new EventEmitter();
  private readonly deps: RuntimeDependencies;
  private readonly devPassthrough: boolean;
  private readonly assetBaseUrlOrigin: string | null;
  private db: MediaCacheDatabase | null = null;
  private storageRoot: string | null = null;
  private status: MediaCacheStatus;
  private syncPromise: Promise<void> | null = null;
  private ipcAttached = false;
  private protocolRegistered = false;

  constructor(
    private readonly options: MediaCacheOptions,
    deps?: Partial<RuntimeDependencies>,
  ) {
    this.deps = {
      fetchImpl: deps?.fetchImpl ?? globalThis.fetch.bind(globalThis),
      now: deps?.now ?? Date.now,
      sleep: deps?.sleep ?? sleep,
    };
    this.devPassthrough = options.devPassthrough ?? false;
    if (this.devPassthrough) {
      this.assetBaseUrlOrigin = normalizeAssetBaseUrl(options.assetBaseUrl);
    } else {
      if (options.assetBaseUrl) {
        throw new Error(
          "assetBaseUrl has no effect when devPassthrough is false. " +
            "Set devPassthrough: true or remove assetBaseUrl.",
        );
      }
      this.assetBaseUrlOrigin = null;
    }
    if (
      this.devPassthrough &&
      this.options.onSyncFailure &&
      this.options.onSyncFailure !== "throw"
    ) {
      // Only emitted when onLog is configured; overridden setting applies regardless.
      this.emitLog("warn", "dev_passthrough_ignores_sync_failure_mode", {
        configured_mode: this.options.onSyncFailure,
      });
    }
    this.status = {
      phase: "idle",
      activeGenerationId: null,
      progress: null,
      lastRun: null,
      error: null,
      updatedAt: this.deps.now(),
    };

    if (!this.devPassthrough) {
      ensureMediaCacheProtocolSchemesPrivileged();
    }
  }

  async start(): Promise<void> {
    await this.ensureInitialized();
    await this.syncNow();
  }

  async syncNow(): Promise<void> {
    await this.ensureInitialized();
    if (this.syncPromise) {
      this.emitLog("debug", "sync_reused", {
        phase: this.status.phase,
        active_generation_id: this.status.activeGenerationId,
      });
      return this.syncPromise;
    }

    this.syncPromise = this.runSync().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async getStatus(): Promise<MediaCacheStatus> {
    await this.ensureInitialized();
    return this.status;
  }

  async getItem(namespace: string, id: string): Promise<ResolvedMediaContentItem | null> {
    const validatedNamespace = parseWithSchema(stringInputSchema, namespace, "item namespace");
    const validatedId = parseWithSchema(stringInputSchema, id, "item id");
    await this.ensureInitialized();
    return this.db!.getItem(validatedNamespace, validatedId);
  }

  async listNamespace(namespace: string, pagination?: PaginationInput) {
    const validatedNamespace = parseWithSchema(stringInputSchema, namespace, "namespace");
    const validatedPagination = parseWithSchema(
      optionalPaginationInputSchema,
      pagination,
      "namespace pagination input",
    );
    await this.ensureInitialized();
    return this.db!.listNamespace(validatedNamespace, validatedPagination);
  }

  async listNamespaceTree(prefix: string, pagination?: PaginationInput) {
    const validatedPrefix = parseWithSchema(stringInputSchema, prefix, "namespace tree prefix");
    const validatedPagination = parseWithSchema(
      optionalPaginationInputSchema,
      pagination,
      "namespace tree pagination input",
    );
    await this.ensureInitialized();
    return this.db!.listNamespaceTree(validatedPrefix, validatedPagination);
  }

  async findByFileStem(stem: string, options?: PaginationInput & { namespace?: string }) {
    const validatedStem = parseWithSchema(stringInputSchema, stem, "file stem");
    const validatedOptions = parseWithSchema(
      optionalFindByFileStemOptionsSchema,
      options,
      "file stem search options",
    );
    await this.ensureInitialized();
    return this.db!.findByFileStem(
      normalizeStem(validatedStem),
      validatedOptions?.namespace,
      validatedOptions,
    );
  }

  async registerProtocol(options?: RegisterProtocolOptions): Promise<void> {
    await this.ensureInitialized();
    if (this.devPassthrough && options?.session === undefined) {
      this.protocolRegistered = true;
      this.emitLog("debug", "protocol_registration_skipped", { reason: "dev_passthrough" });
      return;
    }
    if (this.protocolRegistered) {
      this.emitLog("debug", "protocol_registration_skipped", { reason: "already_registered" });
      return;
    }

    const electron = options?.session ? null : await import("electron");
    const session = options?.session ?? electron!.session.defaultSession;

    const fetchFile =
      options?.fetchFile ??
      (async (request: Request, filePath: string) => createFileResponse(filePath, request));

    session.protocol.handle("media", async (request) => {
      const parsed = new URL(request.url);
      const parts = parsed.pathname.split("/").filter(Boolean);

      if (parsed.hostname !== "asset" || parts.length !== 3) {
        return new Response("Not found", { status: 404 });
      }

      let namespace: string;
      let itemId: string;
      let assetId: string;
      try {
        [namespace, itemId, assetId] = parts.map((part) => decodeURIComponent(part)) as [
          string,
          string,
          string,
        ];
      } catch {
        return new Response("Not found", { status: 404 });
      }

      const target = this.db!.getProtocolAssetTarget(namespace, itemId, assetId);

      if (!target) {
        this.emitLog("debug", "protocol_request_not_found", {
          namespace,
          item_id: itemId,
          asset_id: assetId,
          method: request.method,
        });
        return new Response("Not found", { status: 404 });
      }

      if (!target.absolutePath || !existsSync(target.absolutePath)) {
        this.emitLog("debug", "protocol_request_file_missing", {
          namespace,
          item_id: itemId,
          asset_id: assetId,
          method: request.method,
        });
        return new Response("Not found", { status: 404 });
      }

      this.emitLog("debug", "protocol_request_local_resolved", {
        namespace,
        item_id: itemId,
        asset_id: assetId,
        method: request.method,
        range: request.headers.get("range"),
      });
      return fetchFile(request, target.absolutePath);
    });

    this.protocolRegistered = true;
    this.emitLog("info", "protocol_registered", {});
  }

  async attachIpc(options?: AttachIpcOptions): Promise<void> {
    await this.ensureInitialized();
    if (this.ipcAttached) {
      this.emitLog("debug", "ipc_attach_skipped", { reason: "already_attached" });
      return;
    }

    const electron = options?.ipcMain ? null : await import("electron");
    const ipcMain = options?.ipcMain ?? electron!.ipcMain;

    ipcMain.handle(MEDIA_CACHE_IPC.getStatus, async () => this.getStatus());
    ipcMain.handle(MEDIA_CACHE_IPC.getItem, async (_event, namespace: string, id: string) =>
      this.getItem(namespace, id),
    );
    ipcMain.handle(
      MEDIA_CACHE_IPC.listNamespace,
      async (_event, namespace: string, pagination?: PaginationInput) =>
        this.listNamespace(namespace, pagination),
    );
    ipcMain.handle(
      MEDIA_CACHE_IPC.listNamespaceTree,
      async (_event, prefix: string, pagination?: PaginationInput) =>
        this.listNamespaceTree(prefix, pagination),
    );
    ipcMain.handle(
      MEDIA_CACHE_IPC.findByFileStem,
      async (_event, stem: string, options?: PaginationInput & { namespace?: string }) =>
        this.findByFileStem(stem, options),
    );

    if (electron) {
      this.events.on(MEDIA_CACHE_IPC.statusChanged, (status: MediaCacheStatus) => {
        for (const window of electron.BrowserWindow.getAllWindows()) {
          window.webContents.send(MEDIA_CACHE_IPC.statusChanged, status);
        }
      });
    }

    this.ipcAttached = true;
    this.emitLog("info", "ipc_attached", {});
  }

  private async ensureInitialized(): Promise<void> {
    if (this.db) {
      return;
    }

    this.storageRoot =
      normalizeStorageRoot(this.options.storageRoot) ?? (await defaultStorageRoot());
    mkdirSync(this.storageRoot, { recursive: true });
    mkdirSync(join(this.storageRoot, "temp"), { recursive: true });
    mkdirSync(join(this.storageRoot, "blobs"), { recursive: true });

    this.db = new MediaCacheDatabase(this.storageRoot, {
      devPassthrough: this.devPassthrough,
      assetBaseUrlOrigin: this.assetBaseUrlOrigin,
      onWarn: (contextLabel, err) => {
        if (this.options.onLog) {
          this.emitLog("warn", "resolve_asset_base_url_fallback", {
            context_label: contextLabel,
            error: err != null ? String(err) : undefined,
          });
        } else {
          consoleWarnResolveAssetBaseUrlFallback(contextLabel, err);
        }
      },
    });
    if (this.devPassthrough) {
      this.prepareDevRuntimeState();
    }
    let storedStatus: MediaCacheStatus | null = null;
    let activeGenerationId: number | null = null;
    if (!this.devPassthrough) {
      try {
        storedStatus = this.db.loadStatus();
      } catch (error) {
        if (!(error instanceof DataValidationError)) {
          throw error;
        }

        this.emitLog("warn", "status_snapshot_invalid", {
          error_code: error.code,
          error_message: error.message,
        });
      }
      activeGenerationId = this.db.getActiveGenerationId();
      if (storedStatus) {
        this.status = storedStatus;
      } else if (activeGenerationId !== null) {
        this.status = {
          ...this.status,
          phase: "ready",
          activeGenerationId,
          progress: null,
          error: null,
        };
      }
      this.status.activeGenerationId = activeGenerationId;
    }
    this.emitLog("info", "cache_initialized", {
      storage_root: this.storageRoot,
      active_generation_id: this.status.activeGenerationId,
      dev_passthrough_enabled: this.devPassthrough,
    });
  }

  private prepareDevRuntimeState(): void {
    // Wipe happens before resolveManifest; if manifest resolution later throws, blobs are
    // already gone. Deferring the wipe until after staging would require a broader restructure.
    this.emitLog("warn", "dev_passthrough_clearing_state", {
      storage_root: this.storageRoot,
      reason: "devPassthrough=true clears all local state on startup",
    });
    this.db!.clearAllState();
    rmSync(join(this.storageRoot!, "blobs"), { recursive: true, force: true });
    rmSync(join(this.storageRoot!, "temp"), { recursive: true, force: true });
    mkdirSync(join(this.storageRoot!, "blobs"), { recursive: true });
    mkdirSync(join(this.storageRoot!, "temp"), { recursive: true });
    this.status = {
      ...this.status,
      phase: "idle",
      activeGenerationId: null,
      progress: null,
      lastRun: null,
      error: null,
      updatedAt: this.deps.now(),
    };
  }

  private async runSync(): Promise<void> {
    const now = this.deps.now();
    const runId = this.db!.createSyncRun(now);
    const stats: SyncRunStats = {
      totalAssets: 0,
      downloadedAssets: 0,
      skippedAssets: 0,
      bytesDownloaded: 0,
    };

    this.updateStatus({
      phase: "syncing",
      error: null,
      progress: {
        runId,
        phase: "resolving-manifest",
        totalAssets: 0,
        completedAssets: 0,
        downloadedAssets: 0,
        skippedAssets: 0,
        bytesDownloaded: 0,
      },
    });
    this.emitLog("info", "sync_started", {
      run_id: runId,
      active_generation_id: this.status.activeGenerationId,
    });

    let stagedGenerationId: number | null = null;

    try {
      const manifest = normalizeManifest(await this.options.resolveManifest());
      stagedGenerationId = this.db!.createStagedGeneration(manifest, now);
      this.emitLog("info", "manifest_resolved", {
        run_id: runId,
        staged_generation_id: stagedGenerationId,
        namespace_count: manifest.namespaces.length,
        item_count: manifest.namespaces.reduce(
          (count, namespace) => count + namespace.items.length,
          0,
        ),
        asset_count: manifest.namespaces.reduce(
          (count, namespace) =>
            count +
            namespace.items.reduce((assetCount, item) => assetCount + item.assets.length, 0),
          0,
        ),
      });

      const currentGenerationId = this.db!.getActiveGenerationId();
      const currentAssets = currentGenerationId
        ? this.db!.getGenerationAssets(currentGenerationId)
        : [];
      const stagedAssets = this.db!.getGenerationAssets(stagedGenerationId);
      stats.totalAssets = stagedAssets.length;

      this.updateProgress((progress) => ({
        ...progress,
        phase: "diffing",
        totalAssets: stagedAssets.length,
      }));

      const currentMap = new Map(
        currentAssets.map((row) => [logicalKey(row.namespace, row.itemId, row.assetId), row]),
      );
      const downloads: DownloadTarget[] = [];

      for (const row of stagedAssets) {
        const manifestAsset = findManifestAsset(manifest, row.namespace, row.itemId, row.assetId);
        const activeRow = currentMap.get(logicalKey(row.namespace, row.itemId, row.assetId));
        const activeRelativePath = activeRow?.relativePath ?? null;
        const nextVersion = manifestAsset.asset.resolvedVersion;
        const canReuseActiveBlob =
          activeRelativePath !== null && existsSync(join(this.storageRoot!, activeRelativePath));

        if (this.devPassthrough) {
          stats.skippedAssets += 1;
          continue;
        }

        if (canReuseActiveBlob) {
          const currentVersion = getResolvedVersionFromPath(activeRelativePath);
          if (currentVersion === nextVersion) {
            this.db!.setAssetDownloadState(
              stagedGenerationId,
              row.namespace,
              row.itemId,
              row.assetId,
              activeRelativePath,
              activeRow?.mimeType ?? null,
            );
            stats.skippedAssets += 1;
            continue;
          }
        }

        const request = await this.resolveDownloadRequest(
          manifest,
          row.namespace,
          row.itemId,
          row.assetId,
        );

        downloads.push({
          namespace: row.namespace,
          itemId: row.itemId,
          assetId: row.assetId,
          request,
          fileName: manifestAsset.asset.normalizedFileName,
          resolvedVersion: manifestAsset.asset.resolvedVersion,
          byteLength: manifestAsset.asset.byteLength,
        });
      }

      this.emitLog("info", "sync_diffed", {
        run_id: runId,
        total_assets: stagedAssets.length,
        download_count: downloads.length,
        skipped_assets: stats.skippedAssets,
        dev_passthrough_enabled: this.devPassthrough,
      });

      await this.pruneExpiredDeletions();
      this.cleanupObsoletePartialDownloads(downloads);
      if (!this.devPassthrough) {
        await this.enforceStorageLimits(downloads);

        this.updateProgress((progress) => ({
          ...progress,
          phase: "downloading",
          totalAssets: stagedAssets.length,
          completedAssets: stats.skippedAssets,
          skippedAssets: stats.skippedAssets,
        }));

        for (const download of downloads) {
          this.emitLog("debug", "asset_download_started", {
            run_id: runId,
            namespace: download.namespace,
            item_id: download.itemId,
            asset_id: download.assetId,
            resolved_version: download.resolvedVersion,
            url: download.request.url,
          });
          const { relativePath, fallbackMimeType } = await this.downloadAsset(
            download,
            (chunkBytes) => {
              stats.bytesDownloaded += chunkBytes;
              this.updateProgress((progress) => ({
                ...progress,
                bytesDownloaded: stats.bytesDownloaded,
              }));
            },
          );
          this.db!.setAssetDownloadState(
            stagedGenerationId,
            download.namespace,
            download.itemId,
            download.assetId,
            relativePath,
            fallbackMimeType,
          );
          stats.downloadedAssets += 1;
          this.emitLog("debug", "asset_download_completed", {
            run_id: runId,
            namespace: download.namespace,
            item_id: download.itemId,
            asset_id: download.assetId,
            relative_path: relativePath,
          });
          this.updateProgress((progress) => ({
            ...progress,
            completedAssets: stats.downloadedAssets + stats.skippedAssets,
            downloadedAssets: stats.downloadedAssets,
            skippedAssets: stats.skippedAssets,
            bytesDownloaded: stats.bytesDownloaded,
          }));
        }
      } else {
        this.updateProgress((progress) => ({
          ...progress,
          completedAssets: stagedAssets.length,
          skippedAssets: stagedAssets.length,
        }));
      }

      this.updateProgress((progress) => ({
        ...progress,
        phase: "committing",
      }));

      const previousGenerationId = this.db!.activateGeneration(stagedGenerationId, this.deps.now());
      this.db!.clearPendingDeletionsForGeneration(stagedGenerationId);
      if (previousGenerationId) {
        this.markRemovedAssetsForDeletion(previousGenerationId, stagedGenerationId);
      }
      this.emitLog("info", "generation_committed", {
        run_id: runId,
        previous_generation_id: previousGenerationId,
        active_generation_id: stagedGenerationId,
      });

      this.updateProgress((progress) => ({
        ...progress,
        phase: "pruning",
      }));
      await this.pruneExpiredDeletions();

      const summary = this.db!.completeSyncRun(runId, "success", this.deps.now(), stats);
      this.db!.pruneSyncHistory(this.options.syncHistoryLimit ?? DEFAULT_SYNC_HISTORY_LIMIT);
      this.emitLog("info", "sync_completed", {
        run_id: runId,
        active_generation_id: stagedGenerationId,
        total_assets: summary.stats.totalAssets,
        downloaded_assets: summary.stats.downloadedAssets,
        skipped_assets: summary.stats.skippedAssets,
        bytes_downloaded: summary.stats.bytesDownloaded,
      });
      this.updateStatus({
        phase: "ready",
        activeGenerationId: stagedGenerationId,
        progress: null,
        lastRun: summary,
        error: null,
      });
    } catch (error) {
      if (stagedGenerationId !== null) {
        this.cleanupStagedGenerationFiles(stagedGenerationId, this.db!.getActiveGenerationId());
        this.db!.deleteGeneration(stagedGenerationId);
      }

      const serialized = toSerializedError(error);
      const summary = this.db!.completeSyncRun(
        runId,
        "error",
        this.deps.now(),
        stats,
        serialized.code,
        serialized.message,
      );
      this.emitLog("error", "sync_failed", {
        run_id: runId,
        active_generation_id: this.db!.getActiveGenerationId(),
        error_code: serialized.code,
        error_message: serialized.message,
        total_assets: summary.stats.totalAssets,
        downloaded_assets: summary.stats.downloadedAssets,
        skipped_assets: summary.stats.skippedAssets,
        bytes_downloaded: summary.stats.bytesDownloaded,
      });

      this.updateStatus({
        phase:
          this.devPassthrough || this.options.onSyncFailure === "throw"
            ? "error"
            : this.db!.getActiveGenerationId()
              ? "ready"
              : "error",
        activeGenerationId: this.db!.getActiveGenerationId(),
        progress: null,
        lastRun: summary,
        error: serialized,
      });

      if (this.devPassthrough || this.options.onSyncFailure === "throw") {
        throw error;
      }
    }
  }

  private async resolveDownloadRequest(
    manifest: NormalizedManifest,
    namespaceKey: string,
    itemId: string,
    assetId: string,
  ): Promise<DownloadRequest> {
    const context = findManifestAsset(manifest, namespaceKey, itemId, assetId);
    if (!this.options.resolveAssetRequest) {
      return context.asset.source;
    }

    return this.options.resolveAssetRequest({
      namespace: context.namespace,
      item: context.item,
      asset: context.asset,
    });
  }

  private async enforceStorageLimits(downloads: DownloadTarget[]): Promise<void> {
    const estimatedBlobBytes = downloads.reduce(
      (sum, download) => sum + (download.byteLength ?? 0),
      0,
    );
    const estimatedRemainingDownloadBytes = downloads.reduce(
      (sum, download) => sum + this.remainingDownloadBytes(download),
      0,
    );

    if (this.options.maxCacheBytes !== undefined) {
      const currentBytes = this.currentBytesOnDisk(join(this.storageRoot!, "blobs"));
      if (currentBytes + estimatedBlobBytes > this.options.maxCacheBytes) {
        this.emitLog("warn", "storage_limit_exceeded", {
          current_bytes: currentBytes,
          estimated_download_bytes: estimatedBlobBytes,
          max_cache_bytes: this.options.maxCacheBytes,
        });
        throw new StorageLimitError(
          `Estimated cache size ${currentBytes + estimatedBlobBytes} exceeds maxCacheBytes ${this.options.maxCacheBytes}.`,
        );
      }
    }

    const stats = await statfs(this.storageRoot!);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const reserve = this.options.reserveFreeBytes ?? 0;
    if (availableBytes - estimatedRemainingDownloadBytes < reserve) {
      this.emitLog("warn", "storage_reserve_violation", {
        available_bytes: availableBytes,
        estimated_download_bytes: estimatedRemainingDownloadBytes,
        reserve_free_bytes: reserve,
      });
      throw new StorageLimitError(
        `Estimated download size ${estimatedRemainingDownloadBytes} leaves less than reserveFreeBytes ${reserve}.`,
      );
    }
  }

  private async downloadAsset(
    download: DownloadTarget,
    onChunk: (chunkBytes: number) => void,
  ): Promise<{ relativePath: string; fallbackMimeType: string | null }> {
    const destinationRelativePath = join(
      "blobs",
      sanitizeSegment(download.namespace),
      sanitizeSegment(download.itemId),
      sanitizeSegment(download.assetId),
      sanitizeSegment(download.resolvedVersion),
      sanitizeSegment(download.fileName),
    );
    const destinationPath = join(this.storageRoot!, destinationRelativePath);

    mkdirSync(dirname(destinationPath), { recursive: true });
    const tempPath = this.partialDownloadPath(download);
    mkdirSync(dirname(tempPath), { recursive: true });

    let lastError: unknown = null;

    for (let attempt = 0; attempt < TOTAL_DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        return await this.downloadAssetAttempt(
          download,
          destinationPath,
          destinationRelativePath,
          tempPath,
          onChunk,
        );
      } catch (error) {
        lastError = error;

        if (isNoSpaceError(error)) {
          await unlink(tempPath).catch(() => undefined);
          this.emitLog("error", "asset_download_storage_failed", {
            namespace: download.namespace,
            item_id: download.itemId,
            asset_id: download.assetId,
            url: download.request.url,
          });
          throw new StorageLimitError(
            `Disk is full while downloading ${download.namespace}/${download.itemId}/${download.assetId}.`,
            { cause: error },
          );
        }

        const retryable = isRetryableDownloadError(error);
        if (!retryable) {
          await unlink(tempPath).catch(() => undefined);
          throw error;
        }

        if (attempt === TOTAL_DOWNLOAD_ATTEMPTS - 1) {
          this.emitLog("warn", "asset_download_retry_exhausted", {
            namespace: download.namespace,
            item_id: download.itemId,
            asset_id: download.assetId,
            attempt: attempt + 1,
            partial_path: tempPath,
          });
          break;
        }

        const delayMs = calculateRetryDelay(attempt);
        this.emitLog("warn", "asset_download_retry_scheduled", {
          namespace: download.namespace,
          item_id: download.itemId,
          asset_id: download.assetId,
          attempt: attempt + 1,
          retry_delay_ms: delayMs,
        });
        await this.deps.sleep(delayMs);
      }
    }

    throw lastError;
  }

  private remainingDownloadBytes(download: DownloadTarget): number {
    const expectedBytes = download.byteLength ?? 0;
    const partialBytes = this.partialDownloadBytes(download);
    return Math.max(expectedBytes - partialBytes, 0);
  }

  private partialDownloadBytes(download: DownloadTarget): number {
    const tempPath = this.partialDownloadPath(download);
    return existsSync(tempPath) ? statSync(tempPath).size : 0;
  }

  private async downloadAssetAttempt(
    download: DownloadTarget,
    destinationPath: string,
    destinationRelativePath: string,
    tempPath: string,
    onChunk: (chunkBytes: number) => void,
  ): Promise<{ relativePath: string; fallbackMimeType: string | null }> {
    let restartedWithoutRange = false;

    for (;;) {
      const resumeSize = existsSync(tempPath) ? statSync(tempPath).size : 0;
      const headers = new Headers(download.request.headers);
      if (resumeSize > 0) {
        headers.set("range", `bytes=${resumeSize}-`);
      }

      const response = await this.deps.fetchImpl(download.request.url, {
        method: download.request.method ?? "GET",
        headers,
      });

      if (resumeSize > 0 && response.status === 416) {
        if (restartedWithoutRange) {
          throw createDownloadError(
            `Server rejected range request for ${download.namespace}/${download.itemId}/${download.assetId}.`,
            false,
            response.status,
          );
        }

        restartedWithoutRange = true;
        await unlink(tempPath).catch(() => undefined);
        this.emitLog("debug", "asset_download_range_restart", {
          namespace: download.namespace,
          item_id: download.itemId,
          asset_id: download.assetId,
          resumed_bytes: resumeSize,
          response_status: response.status,
          content_range: response.headers.get("content-range"),
        });
        continue;
      }

      if (!response.ok || !response.body) {
        this.emitLog("warn", "asset_download_rejected", {
          namespace: download.namespace,
          item_id: download.itemId,
          asset_id: download.assetId,
          status: response.status,
          status_text: response.statusText,
          url: download.request.url,
        });
        throw createDownloadError(
          `Download failed for ${download.namespace}/${download.itemId}/${download.assetId}: ${response.status} ${response.statusText}`,
          isRetryableStatus(response.status),
          response.status,
        );
      }

      if (
        resumeSize > 0 &&
        (response.status !== 206 ||
          parseContentRangeStart(response.headers.get("content-range")) !== resumeSize)
      ) {
        if (restartedWithoutRange) {
          throw createDownloadError(
            `Server did not honor range request for ${download.namespace}/${download.itemId}/${download.assetId}.`,
            false,
            response.status,
          );
        }

        restartedWithoutRange = true;
        await unlink(tempPath).catch(() => undefined);
        this.emitLog("debug", "asset_download_range_restart", {
          namespace: download.namespace,
          item_id: download.itemId,
          asset_id: download.assetId,
          resumed_bytes: resumeSize,
          response_status: response.status,
          content_range: response.headers.get("content-range"),
        });
        continue;
      }

      const nodeStream = Readable.fromWeb(
        response.body as unknown as NodeReadableStream<Uint8Array>,
      );
      const writeStream = createWriteStream(tempPath, { flags: resumeSize > 0 ? "a" : "w" });

      nodeStream.on("data", (chunk) => {
        onChunk((chunk as Buffer).byteLength);
      });

      try {
        await pipeline(nodeStream, writeStream);
      } catch (error) {
        throw wrapRetryableDownloadError(error);
      }

      await this.ensureFileSpaceCommit();
      mkdirSync(dirname(destinationPath), { recursive: true });
      rmSync(destinationPath, { force: true });
      renameSyncSafe(tempPath, destinationPath);
      return {
        relativePath: destinationRelativePath,
        fallbackMimeType: normalizeResponseMimeType(response.headers.get("content-type")),
      };
    }
  }

  private async ensureFileSpaceCommit(): Promise<void> {
    const stats = await statfs(this.storageRoot!);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const reserve = this.options.reserveFreeBytes ?? 0;
    if (availableBytes < reserve) {
      throw new StorageLimitError(`Committing download would violate reserveFreeBytes ${reserve}.`);
    }
  }

  private partialDownloadPath(download: DownloadTarget): string {
    return join(
      this.storageRoot!,
      "temp",
      sanitizeSegment(download.namespace),
      sanitizeSegment(download.itemId),
      sanitizeSegment(download.assetId),
      sanitizeSegment(download.resolvedVersion),
      `${sanitizeSegment(download.fileName)}.part`,
    );
  }

  private cleanupObsoletePartialDownloads(downloads: DownloadTarget[]): void {
    const tempRoot = join(this.storageRoot!, "temp");
    if (!existsSync(tempRoot)) {
      return;
    }

    const resumablePaths = new Set(downloads.map((download) => this.partialDownloadPath(download)));
    for (const filePath of listFilesRecursively(tempRoot)) {
      if (!filePath.endsWith(".part") || resumablePaths.has(filePath)) {
        continue;
      }

      rmSync(filePath, { force: true });
      pruneEmptyParents(filePath, this.storageRoot!);
    }
  }

  private cleanupStagedGenerationFiles(
    stagedGenerationId: number,
    activeGenerationId: number | null,
  ): void {
    const activePaths = new Set(
      activeGenerationId
        ? this.db!.getGenerationAssets(activeGenerationId).flatMap((row) =>
            row.relativePath ? [row.relativePath] : [],
          )
        : [],
    );

    for (const row of this.db!.getGenerationAssets(stagedGenerationId)) {
      if (!row.relativePath || activePaths.has(row.relativePath)) {
        continue;
      }

      const absolutePath = join(this.storageRoot!, row.relativePath);
      rmSync(absolutePath, { force: true });
      pruneEmptyParents(absolutePath, this.storageRoot!);
    }
  }

  private markRemovedAssetsForDeletion(
    previousGenerationId: number,
    stagedGenerationId: number,
  ): void {
    const previousAssets = this.db!.getGenerationAssets(previousGenerationId);
    const nextAssets = new Map(
      this.db!.getGenerationAssets(stagedGenerationId).map((row) => [
        logicalKey(row.namespace, row.itemId, row.assetId),
        row.relativePath,
      ]),
    );
    const deleteAfterMs =
      this.deps.now() + (this.options.staleDeleteAfterMs ?? DEFAULT_STALE_DELETE_MS);

    let markedCount = 0;
    for (const row of previousAssets) {
      const key = logicalKey(row.namespace, row.itemId, row.assetId);
      const nextRelativePath = nextAssets.get(key);
      if (row.relativePath && nextRelativePath !== row.relativePath) {
        this.db!.markPendingDeletion(
          key,
          row.namespace,
          row.itemId,
          row.assetId,
          row.relativePath,
          previousGenerationId,
          deleteAfterMs,
        );
        markedCount += 1;
      }
    }
    this.emitLog("debug", "assets_marked_for_deletion", {
      previous_generation_id: previousGenerationId,
      active_generation_id: stagedGenerationId,
      marked_count: markedCount,
      delete_after_ms: deleteAfterMs,
    });
  }

  private async pruneExpiredDeletions(): Promise<void> {
    const expired = this.db!.getExpiredPendingDeletions(this.deps.now());
    if (expired.length === 0) {
      this.emitLog("debug", "deletion_prune_skipped", { expired_count: 0 });
      return;
    }

    for (const deletion of expired) {
      const absolutePath = join(this.storageRoot!, deletion.relativePath);
      rmSync(absolutePath, { force: true });
      pruneEmptyParents(absolutePath, this.storageRoot!);
    }

    this.db!.deletePendingDeletions(expired.map((item) => item.deletionKey));
    this.emitLog("debug", "assets_pruned", { pruned_count: expired.length });
  }

  private currentBytesOnDisk(directory: string): number {
    if (!existsSync(directory)) {
      return 0;
    }

    const stats = statSync(directory);
    if (stats.isFile()) {
      return stats.size;
    }

    return readdirSync(directory).reduce(
      (sum, entry) => sum + this.currentBytesOnDisk(join(directory, entry)),
      0,
    );
  }

  private updateProgress(transform: (progress: SyncProgress) => SyncProgress): void {
    if (!this.status.progress) {
      return;
    }
    this.updateStatus({
      progress: transform(this.status.progress),
    });
  }

  private updateStatus(partial: Partial<MediaCacheStatus>): void {
    this.status = {
      ...this.status,
      ...partial,
      updatedAt: this.deps.now(),
    };
    this.db?.saveStatus(this.status, this.status.updatedAt);
    this.events.emit(MEDIA_CACHE_IPC.statusChanged, this.status);
  }

  private emitLog(
    level: MediaCacheLogLevel,
    event: string,
    fields: Record<string, ReturnType<typeof normalizeLogValue>> = {},
  ): void {
    if (!this.options.onLog) {
      return;
    }

    const threshold = LOG_LEVEL_WEIGHT[this.options.logLevel ?? "info"];
    if (LOG_LEVEL_WEIGHT[level] < threshold) {
      return;
    }

    const entry: MediaCacheLogEvent = {
      timestamp: new Date(this.deps.now()).toISOString(),
      level,
      event,
      service: "rockhallweb-electron-offline-content",
      component: "media-cache",
      ...fields,
    };

    try {
      this.options.onLog(entry);
    } catch {
      // Consumer loggers must not break cache behavior.
    }
  }
}

function logicalKey(namespace: string, itemId: string, assetId: string): string {
  return JSON.stringify([namespace, itemId, assetId]);
}

function sanitizeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function normalizeStorageRoot(storageRoot: string | undefined): string | null {
  if (storageRoot === undefined) {
    return null;
  }

  return storageRoot.trim().length > 0 ? storageRoot : null;
}

function normalizeAssetBaseUrl(assetBaseUrl: string | null | undefined): string | null {
  if (!assetBaseUrl) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(assetBaseUrl);
  } catch {
    throw new Error(`assetBaseUrl is not a valid URL: "${assetBaseUrl}"`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("assetBaseUrl must not include credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("assetBaseUrl must not include a query string or hash fragment.");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("assetBaseUrl must be an origin without a path.");
  }

  return parsed.origin;
}

function pruneEmptyParents(pathToFile: string, storageRoot: string): void {
  let current = dirname(pathToFile);
  while (current.startsWith(storageRoot) && current !== storageRoot) {
    if (existsSync(current) && readdirSync(current).length === 0) {
      rmSync(current, { recursive: true, force: true });
      current = dirname(current);
      continue;
    }
    break;
  }
}

function listFilesRecursively(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const stats = statSync(directory);
  if (stats.isFile()) {
    return [directory];
  }

  return readdirSync(directory).flatMap((entry) => listFilesRecursively(join(directory, entry)));
}

function findManifestAsset(
  manifest: NormalizedManifest,
  namespaceKey: string,
  itemId: string,
  assetId: string,
) {
  const namespace = manifest.namespaces.find((candidate) => candidate.key === namespaceKey);
  if (!namespace) {
    throw new ManifestValidationError(`Namespace "${namespaceKey}" not found in manifest.`);
  }

  const item = namespace.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new ManifestValidationError(`Item "${namespaceKey}/${itemId}" not found in manifest.`);
  }

  const asset = item.assets.find((candidate) => candidate.id === assetId);
  if (!asset) {
    throw new ManifestValidationError(
      `Asset "${namespaceKey}/${itemId}/${assetId}" not found in manifest.`,
    );
  }

  return { namespace, item, asset };
}

function getResolvedVersionFromPath(relativePath: string): string | null {
  const parts = relativePath.split(/[\\/]/);
  return parts.length >= 5 ? decodeURIComponent(parts.at(-2)!) : null;
}

function renameSyncSafe(from: string, to: string): void {
  renameSync(from, to);
}

const TOTAL_DOWNLOAD_ATTEMPTS = 4;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

type RetryableDownloadError = Error & {
  retryable?: boolean;
  status?: number;
};

function calculateRetryDelay(attempt: number): number {
  const baseDelay = 1000 * Math.pow(2, attempt);
  const jitter = Math.floor(baseDelay * 0.25 * Math.random());
  return baseDelay + jitter;
}

function createDownloadError(
  message: string,
  retryable: boolean,
  status?: number,
  cause?: unknown,
): RetryableDownloadError {
  const error = new SyncFailureError(
    message,
    cause ? { cause } : undefined,
  ) as RetryableDownloadError;
  error.retryable = retryable;
  error.status = status;
  return error;
}

function wrapRetryableDownloadError(error: unknown): RetryableDownloadError {
  if (error instanceof SyncFailureError) {
    return error as RetryableDownloadError;
  }

  if (error instanceof Error) {
    const wrapped = new SyncFailureError(error.message, { cause: error }) as RetryableDownloadError;
    wrapped.retryable = hasRetryableDownloadSignal(error);
    return wrapped;
  }

  const wrapped = new SyncFailureError(String(error)) as RetryableDownloadError;
  wrapped.retryable = false;
  return wrapped;
}

function isRetryableDownloadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as RetryableDownloadError;
  if (candidate.retryable !== undefined) {
    return candidate.retryable;
  }

  return hasRetryableDownloadSignal(error);
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

function isRetryableErrorCode(code: string | undefined): boolean {
  return code !== undefined && RETRYABLE_ERROR_CODES.has(code);
}

function isRetryableMessage(message: string): boolean {
  const value = message.toLowerCase();
  return (
    value.includes("aborted") ||
    value.includes("connection") ||
    value.includes("network") ||
    value.includes("reset") ||
    value.includes("socket") ||
    value.includes("terminated") ||
    value.includes("timeout")
  );
}

function hasRetryableDownloadSignal(error: Error): boolean {
  return collectErrorChain(error).some(
    (entry) =>
      isRetryableErrorCode((entry as NodeJS.ErrnoException).code) ||
      isRetryableMessage(entry.message),
  );
}

function collectErrorChain(error: Error): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;

  while (current instanceof Error && !chain.includes(current)) {
    chain.push(current);
    current = current.cause;
  }

  return chain;
}

function normalizeResponseMimeType(contentType: string | null): string | null {
  const value = contentType?.trim();
  return value && value.length > 0 ? value : null;
}

function parseContentRangeStart(contentRange: string | null): number | null {
  if (!contentRange) {
    return null;
  }

  const match = contentRange.match(/^bytes (\d+)-\d+\/(?:\d+|\*)$/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function createFileResponse(filePath: string, request: Request): Response {
  const stats = statSync(filePath);
  const size = stats.size;
  const rangeHeader = request.headers.get("range");
  const mimeType = inferMimeType(filePath);
  const baseHeaders = new Headers({
    "accept-ranges": "bytes",
    "content-type": mimeType,
  });

  if (request.method === "HEAD") {
    baseHeaders.set("content-length", String(size));
    return new Response(null, {
      status: 200,
      headers: baseHeaders,
    });
  }

  if (!rangeHeader) {
    baseHeaders.set("content-length", String(size));
    return new Response(Readable.toWeb(createReadStream(filePath)) as BodyInit, {
      status: 200,
      headers: baseHeaders,
    });
  }

  const parsedRange = parseByteRange(rangeHeader, size);
  if (!parsedRange) {
    baseHeaders.set("content-range", `bytes */${size}`);
    return new Response(null, {
      status: 416,
      headers: baseHeaders,
    });
  }

  const { start, end } = parsedRange;
  const chunkLength = end - start + 1;
  baseHeaders.set("content-length", String(chunkLength));
  baseHeaders.set("content-range", `bytes ${start}-${end}/${size}`);
  return new Response(Readable.toWeb(createReadStream(filePath, { start, end })) as BodyInit, {
    status: 206,
    headers: baseHeaders,
  });
}

function parseByteRange(rangeHeader: string, size: number): { start: number; end: number } | null {
  if (!rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const value = rangeHeader.slice("bytes=".length).trim();
  if (value.length === 0 || value.includes(",")) {
    return null;
  }

  const [startText, endText] = value.split("-", 2);
  if (startText === undefined || endText === undefined) {
    return null;
  }

  if (startText === "") {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    const start = Math.max(size - suffixLength, 0);
    const end = size - 1;
    return start <= end ? { start, end } : null;
  }

  const start = Number.parseInt(startText, 10);
  const end = endText === "" ? size - 1 : Number.parseInt(endText, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  if (start < 0 || end < start || start >= size) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

function inferMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".mp4")) {
    return "video/mp4";
  }
  if (lower.endsWith(".webm")) {
    return "video/webm";
  }
  if (lower.endsWith(".mov")) {
    return "video/quicktime";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".vtt")) {
    return "text/vtt";
  }
  if (lower.endsWith(".srt")) {
    return "application/x-subrip";
  }
  if (lower.endsWith(".mp3")) {
    return "audio/mpeg";
  }
  if (lower.endsWith(".wav")) {
    return "audio/wav";
  }
  if (lower.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (lower.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }
  if (lower.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  return "application/octet-stream";
}

function normalizeLogValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeLogValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, normalizeLogValue(entry)])
        .filter(([, entry]) => entry !== undefined),
    ) as JsonValue;
  }

  return String(value);
}
