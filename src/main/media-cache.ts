import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import type { IpcMain, Session } from "electron";
import { registerBridgeOperationHandlers } from "../shared/bridge-operations.js";
import { MEDIA_CACHE_IPC } from "../shared/ipc.js";
import { normalizeManifest } from "../shared/normalize.js";
import { normalizeStem } from "../shared/stem.js";
import {
  DataValidationError,
  StoreExpiredError,
  StoreValidationError,
  toSerializedError,
} from "../shared/errors.js";
import type {
  AssetKeyInput,
  FlatManifest,
  FileStemMatch,
  JsonValue,
  MediaCacheAppPath,
  MediaCacheLogEvent,
  MediaCacheLogFormat,
  MediaCacheLogHandler,
  MediaCacheLogLevel,
  MediaCacheOptions,
  MediaCacheStatus,
  PaginationInput,
  PaginationResult,
  ResolvedMediaAsset,
  SyncProgress,
  SyncRunStats,
} from "../shared/types.js";
import { formatMediaCacheConsoleLine } from "../internal/log-format.js";
import {
  mediaCacheStoragePathSchema,
  optionalPaginationInputSchema,
  parseWithSchema,
  stringInputSchema,
} from "../internal/validation.js";
import { MediaCacheDatabase, type ActiveAssetRow, type GenerationAssetRow } from "./database.js";
import { projectResolvedAsset } from "./catalog-projection.js";
import { consoleWarnResolveAssetBaseUrlFallback } from "../internal/url-warn.js";
import { hashKey } from "../internal/asset-key.js";
import type { StorageRootLockHandle } from "./storage-root-lock.js";
import {
  acquireStorageRootLock,
  disableStorageRootLockForTests,
  enableStorageRootLockForTests,
  resetStorageRootLocksForTests,
} from "./storage-root-lock.js";
import {
  AssetDownloader,
  blobRelativePath,
  listFilesRecursively,
  partialDownloadBytes,
  type AssetDownloadTarget,
  type QueuedAssetDownloadTarget,
} from "./asset-download.js";
import {
  GenerationLifecycle,
  normalizeStoredRelativePath,
  pruneEmptyParents,
} from "./generation-lifecycle.js";
import { registerMediaProtocolHandler } from "./media-protocol.js";
import { StorageBudget } from "./storage-budget.js";

export { DEFAULT_RESERVE_FREE_BYTES, effectiveReserveFreeBytes } from "./storage-budget.js";

const requireElectron = createRequire(process.execPath);

const DEFAULT_SYNC_HISTORY_LIMIT = 50;
const DEFAULT_DOWNLOAD_CONCURRENCY = 2;
type StatFsResult = Awaited<ReturnType<typeof statfs>>;
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

function isElectronLoadError(error: unknown): boolean {
  return (
    isModuleNotFoundError(error) ||
    (error instanceof Error && error.message.startsWith("Electron failed to install correctly"))
  );
}

async function importElectron(): Promise<typeof import("electron") | null> {
  try {
    return await import("electron");
  } catch (error) {
    if (isElectronLoadError(error)) {
      return null;
    }
    throw error;
  }
}

/** True when not a production build; Electron `forge start` often leaves `NODE_ENV` unset. */
function isNonProductionNodeEnv(): boolean {
  return process.env.NODE_ENV !== "production";
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
    if (isElectronLoadError(error)) {
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

/**
 * Clears any held storage-root locks so tests can run multiple scenarios in one process.
 * **Unit tests only**; do not use in application code.
 * @internal
 */
export const resetMediaCacheStorageRootLocksForTests = resetStorageRootLocksForTests;

/**
 * Disables storage-root exclusivity checks so tests can exercise multiple cache instances freely.
 * **Unit tests only**; do not use in application code.
 * @internal
 */
export const disableMediaCacheStorageRootLockForTests = disableStorageRootLockForTests;

/**
 * Re-enables storage-root exclusivity checks after test-only overrides.
 * **Unit tests only**; do not use in application code.
 * @internal
 */
export const enableMediaCacheStorageRootLockForTests = enableStorageRootLockForTests;

interface RuntimeDependencies {
  fetchImpl: typeof globalThis.fetch;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
  resolveAppPath: (name: MediaCacheAppPath) => Promise<string>;
  statfs: (path: string) => Promise<StatFsResult>;
}

/** Options for {@link MediaCacheMain.registerProtocol}. */
interface RegisterProtocolOptions {
  /** Electron session to register the `media:` handler on (defaults to `defaultSession`). */
  session?: Session;
  /** Custom file-serving handler; receives the protocol request and resolved local path. */
  fetchFile?: (request: Request, filePath: string) => Promise<Response>;
}

/** Options for {@link MediaCacheMain.attachIpc}. */
interface AttachIpcOptions {
  /** Custom `ipcMain` instance (defaults to `electron.ipcMain`). */
  ipcMain?: IpcMain;
}

/**
 * Main-process controller: syncs the store, stores blobs, serves `media:` URLs, and can expose
 * the same operations to renderers via IPC. In offline mode (default), construct the cache before
 * `app.whenReady()` so the privileged `media:` scheme can be registered, then after ready call
 * {@link MediaCacheMain.start} for the one-call happy path.
 *
 * `MediaCache` requires exclusive ownership of its resolved `storageRoot`. The first process that
 * acquires that root remains the owner for the process lifetime. A second process (or cache
 * instance) targeting the same root throws {@link import("../shared/errors.js").StorageOwnershipError}.
 */
export interface MediaCacheMain {
  /**
   * One-call setup: register protocol, attach IPC, initialize storage, then run initial sync.
   * Cache-root ownership is enforced during initialization, before SQLite or blob writes begin.
   */
  start(): Promise<void>;
  /** Runs or joins the current sync; concurrent callers share one run. */
  syncNow(): Promise<void>;
  /** Latest status snapshot (phase, progress, last run, error). */
  getStatus(): Promise<MediaCacheStatus>;
  /** Single asset by key, or null if missing. */
  getAsset(key: string): Promise<ResolvedMediaAsset | null>;
  /** Assets matching a secondary index value, paginated. */
  listByIndex(
    indexName: string,
    value: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<ResolvedMediaAsset>>;
  /** Search by normalized file name stem. */
  findByFileStem(
    stem: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<FileStemMatch>>;
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
  /** When no custom handler is configured, log to the main-process console in development. */
  private readonly defaultDevelopmentConsole: boolean;
  /** Custom structured log sink when configured via `options.logging.onLog`. */
  private readonly logHandler: MediaCacheLogHandler | null;
  /** Built-in console line shape when {@link defaultDevelopmentConsole} is active. */
  private readonly logFormat: MediaCacheLogFormat;
  /** Minimum severity emitted for the currently active log sink. */
  private readonly effectiveLogLevel: MediaCacheLogLevel;
  private readonly devPassthrough: boolean;
  private readonly assetBaseUrlOrigin: string | null;
  private storageRootLock: StorageRootLockHandle | null = null;
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
      resolveAppPath: deps?.resolveAppPath ?? resolveElectronAppPath,
      statfs: deps?.statfs ?? statfs,
    };
    const logging = normalizeLoggingOptions(options.logging);
    this.logHandler = logging.onLog;
    this.defaultDevelopmentConsole =
      this.logHandler == null && isNonProductionNodeEnv() && process.env.VITEST !== "true";
    this.logFormat = logging.format;
    this.effectiveLogLevel =
      logging.level ??
      (this.logHandler == null && this.defaultDevelopmentConsole ? "debug" : "info");
    this.devPassthrough = options.devPassthrough ?? process.env.NODE_ENV === "development";
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
    if (this.devPassthrough) {
      this.emitLog("info", "dev_passthrough_active", {
        source: options.devPassthrough === true ? "option" : "node_env",
        node_env: process.env.NODE_ENV ?? null,
      });
    }
    if (
      this.devPassthrough &&
      this.options.onSyncFailure &&
      this.options.onSyncFailure !== "throw"
    ) {
      this.emitLog("warn", "dev_passthrough_ignores_sync_failure_mode", {
        configured_mode: this.options.onSyncFailure,
      });
    }
    this.status = {
      phase: "idle",
      storageRoot: null,
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
    await this.registerProtocol();
    await this.attachIpc();
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

  async getAsset(key: AssetKeyInput): Promise<ResolvedMediaAsset | null> {
    const hashedKey = hashKey(key);
    await this.ensureInitialized();
    const row = this.db!.getAssetRow(hashedKey);
    return row ? this.projectAsset(row) : null;
  }

  async listByIndex(
    indexName: string,
    value: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<ResolvedMediaAsset>> {
    const validatedIndexName = parseWithSchema(stringInputSchema, indexName, "index name");
    const validatedValue = parseWithSchema(stringInputSchema, value, "index value");
    const validatedPagination = parseWithSchema(
      optionalPaginationInputSchema,
      pagination,
      "index pagination input",
    );
    await this.ensureInitialized();
    const page = this.db!.listRowsByIndex(validatedIndexName, validatedValue, validatedPagination);
    return {
      items: page.items.map((row) => this.projectAsset(row)),
      nextCursor: page.nextCursor,
    };
  }

  async findByFileStem(
    stem: string,
    pagination?: PaginationInput,
  ): Promise<PaginationResult<FileStemMatch>> {
    const validatedStem = parseWithSchema(stringInputSchema, stem, "file stem");
    const validatedPagination = parseWithSchema(
      optionalPaginationInputSchema,
      pagination,
      "file stem pagination input",
    );
    await this.ensureInitialized();
    const page = this.db!.findRowsByFileStem(normalizeStem(validatedStem), validatedPagination);
    return {
      items: page.items.map((row) => ({ asset: this.projectAsset(row) })),
      nextCursor: page.nextCursor,
    };
  }

  private projectAsset(row: ActiveAssetRow): ResolvedMediaAsset {
    return projectResolvedAsset(row, {
      devPassthrough: this.devPassthrough,
      assetBaseUrlOrigin: this.assetBaseUrlOrigin,
      onWarn: (contextLabel, err) => {
        if (this.logHandler != null || this.defaultDevelopmentConsole) {
          this.emitLog("warn", "resolve_asset_base_url_fallback", {
            context_label: contextLabel,
            error: err != null ? String(err) : undefined,
          });
        } else {
          consoleWarnResolveAssetBaseUrlFallback(contextLabel, err);
        }
      },
    });
  }

  async registerProtocol(options?: RegisterProtocolOptions): Promise<void> {
    await this.ensureInitialized();
    if (this.devPassthrough) {
      this.protocolRegistered = true;
      this.emitLog("debug", "protocol_registration_skipped", { reason: "dev_passthrough" });
      return;
    }
    if (this.protocolRegistered) {
      this.emitLog("debug", "protocol_registration_skipped", { reason: "already_registered" });
      return;
    }

    const electron = options?.session ? null : await importElectron();
    const session = options?.session ?? electron?.session?.defaultSession;
    if (!session || typeof session.protocol?.handle !== "function") {
      this.emitLog("debug", "protocol_registration_skipped", {
        reason: "session_unavailable",
      });
      return;
    }

    registerMediaProtocolHandler(session, {
      resolveAssetTarget: (assetKey) => this.db!.getProtocolAssetTarget(assetKey),
      fetchFile: options?.fetchFile,
      onDebugLog: (event, fields) => this.emitLog("debug", event, fields),
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

    const electron = options?.ipcMain ? null : await importElectron();
    const ipcMain = options?.ipcMain ?? electron?.ipcMain;
    if (!ipcMain || typeof ipcMain.handle !== "function") {
      this.emitLog("debug", "ipc_attach_skipped", {
        reason: "ipc_main_unavailable",
      });
      return;
    }

    registerBridgeOperationHandlers(ipcMain, {
      getStatus: async () => this.getStatus(),
      syncNow: async () => this.syncNow(),
      getAsset: async (key) => this.getAsset(key),
      listByIndex: async (indexName, value, pagination) =>
        this.listByIndex(indexName, value, pagination),
      findByFileStem: async (stem, pagination) => this.findByFileStem(stem, pagination),
    });

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

    this.storageRoot = await resolveStorageRoot(this.options.storagePath, this.deps.resolveAppPath);
    mkdirSync(this.storageRoot, { recursive: true });
    this.storageRootLock ??= acquireStorageRootLock(this.storageRoot, this);
    mkdirSync(join(this.storageRoot, "temp"), { recursive: true });
    mkdirSync(join(this.storageRoot, "blobs"), { recursive: true });

    if (!this.devPassthrough) {
      this.emitLog("info", "cache_storage_location", {
        storage_root: this.storageRoot,
      });
    }

    this.db = new MediaCacheDatabase(this.storageRoot);
    if (this.devPassthrough) {
      this.prepareDevRuntimeState();
    }
    let storedStatus: MediaCacheStatus | null = null;
    let activeGenerationId: number | null = null;
    if (!this.devPassthrough) {
      activeGenerationId = this.createGenerationLifecycle().reconcileOrphanedStagedGenerations();
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
    this.status = {
      ...this.status,
      storageRoot: this.storageRoot,
    };
    this.emitLog("info", "cache_initialized", {
      storage_root: this.storageRoot,
      active_generation_id: this.status.activeGenerationId,
      dev_passthrough_enabled: this.devPassthrough,
    });
  }

  private prepareDevRuntimeState(): void {
    // Wipe happens before resolveStore; if store resolution later throws, blobs are
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
        phase: "resolving-store",
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
      const store = await this.options.resolveStore();
      const manifest = normalizeManifest(store._serialize());
      this.assertStoreNotExpired(manifest, runId);
      stagedGenerationId = this.db!.createStagedGeneration(manifest, now);
      this.emitLog("info", "store_resolved", {
        run_id: runId,
        staged_generation_id: stagedGenerationId,
        index_count: manifest.indexDefinitions.length,
        asset_count: manifest.assets.length,
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

      const manifestAssetMap = new Map(manifest.assets.map((asset) => [asset.key, asset]));
      const currentMap = new Map(currentAssets.map((row) => [row.assetKey, row]));
      const downloads: QueuedAssetDownloadTarget[] = [];

      for (const row of stagedAssets) {
        const manifestAsset = manifestAssetMap.get(row.assetKey);
        if (!manifestAsset) {
          throw new StoreValidationError(`Asset "${row.assetKey}" not found in serialized store.`);
        }

        const activeRow = currentMap.get(row.assetKey);
        const activeRelativePath = activeRow?.relativePath ?? null;
        const normalizedActiveRelativePath =
          activeRelativePath === null ? null : normalizeStoredRelativePath(activeRelativePath);
        const nextVersion = manifestAsset.version;
        const canReuseActiveBlob =
          normalizedActiveRelativePath !== null &&
          existsSync(join(this.storageRoot!, normalizedActiveRelativePath));

        if (this.devPassthrough) {
          stats.skippedAssets += 1;
          continue;
        }

        if (canReuseActiveBlob) {
          const currentVersion = getResolvedVersionFromPath(normalizedActiveRelativePath);
          if (currentVersion === nextVersion) {
            this.db!.setAssetDownloadState(
              stagedGenerationId,
              row.assetKey,
              normalizedActiveRelativePath,
              activeRow?.mimeType ?? null,
            );
            stats.skippedAssets += 1;
            continue;
          }
        }

        // Adopt a complete blob left behind by a previously failed sync, whatever
        // generation staged it. Blobs only ever appear at this exact path via an
        // atomic rename after the download stream fully completes (partials stay
        // in temp/ as .part files), so an existing file is a complete copy of
        // exactly this version. The manifest mime type wins over the null
        // fallback via COALESCE in setAssetDownloadState.
        //
        // We intentionally do not verify the file against manifestAsset.byteLength:
        // that field is a caller-declared estimate (fractional values are allowed;
        // see MediaAssetInput.byteLength), so an equality check would reject valid
        // blobs and re-download them on every sync.
        const stagedRelativePath = normalizeStoredRelativePath(
          blobRelativePath({
            assetKey: row.assetKey,
            version: nextVersion,
            fileName: manifestAsset.fileName,
          }),
        );
        if (existsSync(join(this.storageRoot!, stagedRelativePath))) {
          this.db!.setAssetDownloadState(
            stagedGenerationId,
            row.assetKey,
            stagedRelativePath,
            null,
          );
          stats.skippedAssets += 1;
          continue;
        }

        downloads.push({
          assetKey: row.assetKey,
          version: manifestAsset.version,
          fileName: manifestAsset.fileName,
          byteLength: manifestAsset.byteLength,
        });
      }

      this.emitLog("info", "sync_diffed", {
        run_id: runId,
        total_assets: stagedAssets.length,
        download_count: downloads.length,
        skipped_assets: stats.skippedAssets,
        dev_passthrough_enabled: this.devPassthrough,
      });

      this.createGenerationLifecycle().pruneExpiredDeletions(this.deps.now());
      this.cleanupObsoletePartialDownloads(downloads);
      if (!this.devPassthrough) {
        this.pruneUnreferencedBlobs(
          this.collectReferencedBlobPaths(
            currentAssets,
            // Re-read staged rows so reused/adopted assets carry the resolved
            // relativePath set during the diff loop, which can differ from the
            // manifest-computed path (e.g. an asset reused from the active
            // generation keeps its old fileName when only fileName changed).
            this.db!.getGenerationAssets(stagedGenerationId),
            manifestAssetMap,
          ),
        );
        await this.enforceStorageLimits(downloads);

        this.updateProgress((progress) => ({
          ...progress,
          phase: "downloading",
          totalAssets: stagedAssets.length,
          completedAssets: stats.skippedAssets,
          skippedAssets: stats.skippedAssets,
        }));

        const downloadGenerationId = stagedGenerationId;
        const downloader = this.createAssetDownloader();
        // A non-finite override (NaN/Infinity) would slip past the min/max clamp and leave
        // workerCount NaN, so Array.from below would spawn zero workers and commit a
        // generation with no downloads performed. Fall back to the default in that case.
        const requestedConcurrency =
          this.options.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY;
        const workerCount = Math.min(
          Number.isFinite(requestedConcurrency)
            ? Math.max(1, Math.floor(requestedConcurrency))
            : DEFAULT_DOWNLOAD_CONCURRENCY,
          Math.max(downloads.length, 1),
        );
        let nextDownloadIndex = 0;
        // First failure stops workers from dequeuing more downloads; in-flight downloads run to
        // completion (their Partial Downloads stay resumable) before the error propagates.
        let firstDownloadError: unknown = null;

        const downloadWorker = async (): Promise<void> => {
          while (firstDownloadError === null && nextDownloadIndex < downloads.length) {
            const queuedDownload = downloads[nextDownloadIndex]!;
            nextDownloadIndex += 1;

            try {
              this.assertStoreNotExpired(manifest, runId, queuedDownload);
              const download: AssetDownloadTarget = {
                ...queuedDownload,
                request: { url: manifestAssetMap.get(queuedDownload.assetKey)!.url },
              };
              this.emitLog("debug", "asset_download_started", {
                run_id: runId,
                asset_key: download.assetKey,
                version: download.version,
                url: download.request.url,
              });
              const { relativePath, fallbackMimeType } = await downloader.downloadAsset(
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
                downloadGenerationId,
                download.assetKey,
                relativePath,
                fallbackMimeType,
              );
              stats.downloadedAssets += 1;
              this.emitLog("debug", "asset_download_completed", {
                run_id: runId,
                asset_key: download.assetKey,
                relative_path: relativePath,
              });
              this.updateProgress((progress) => ({
                ...progress,
                completedAssets: stats.downloadedAssets + stats.skippedAssets,
                downloadedAssets: stats.downloadedAssets,
                skippedAssets: stats.skippedAssets,
                bytesDownloaded: stats.bytesDownloaded,
              }));
            } catch (error) {
              if (firstDownloadError === null) {
                firstDownloadError = error;
              }
              return;
            }
          }
        };

        await Promise.all(Array.from({ length: workerCount }, () => downloadWorker()));
        if (firstDownloadError !== null) {
          throw firstDownloadError;
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

      const { previousGenerationId } = this.createGenerationLifecycle().commitStagedGeneration(
        stagedGenerationId,
        this.deps.now(),
      );
      this.emitLog("info", "generation_committed", {
        run_id: runId,
        previous_generation_id: previousGenerationId,
        active_generation_id: stagedGenerationId,
      });

      this.updateProgress((progress) => ({
        ...progress,
        phase: "pruning",
      }));
      this.createGenerationLifecycle().pruneExpiredDeletions(this.deps.now());

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
        this.createGenerationLifecycle().rollbackStagedGeneration(stagedGenerationId);
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

  private assertStoreNotExpired(
    manifest: FlatManifest,
    runId: number,
    download?: Pick<QueuedAssetDownloadTarget, "assetKey">,
  ): void {
    if (!manifest.expiresAt) {
      return;
    }

    const expiresAtMs = Date.parse(manifest.expiresAt);
    const now = this.deps.now();
    if (Number.isNaN(expiresAtMs) || now < expiresAtMs) {
      return;
    }

    this.emitLog("warn", "store_expired", {
      run_id: runId,
      expires_at: manifest.expiresAt,
      now_ms: now,
      asset_key: download?.assetKey,
    });

    const assetLabel = download ? ` before downloading ${download.assetKey}` : "";
    throw new StoreExpiredError(
      `Store URLs expired at ${manifest.expiresAt}${assetLabel}. Refresh the store and retry sync.`,
    );
  }

  private async enforceStorageLimits(downloads: QueuedAssetDownloadTarget[]): Promise<void> {
    await this.createStorageBudget().ensureDownloadBudget(downloads);
  }

  private async ensureFileSpaceCommit(): Promise<void> {
    await this.createStorageBudget().ensureCommitReserve();
  }

  private cleanupObsoletePartialDownloads(downloads: QueuedAssetDownloadTarget[]): void {
    this.createAssetDownloader().cleanupObsoletePartialDownloads(downloads);
  }

  private createAssetDownloader(): AssetDownloader {
    return new AssetDownloader(
      this.storageRoot!,
      { fetchImpl: this.deps.fetchImpl, sleep: this.deps.sleep },
      {
        budget: this.createStorageBudget(),
        emitLog: (level, event, fields = {}) => this.emitLog(level, event, fields),
      },
    );
  }

  private createStorageBudget(): StorageBudget {
    const storageRoot = this.storageRoot!;
    return new StorageBudget(
      storageRoot,
      { partialDownloadBytes: (download) => partialDownloadBytes(storageRoot, download) },
      { statfs: this.deps.statfs },
      {
        maxCacheBytes: this.options.maxCacheBytes,
        reserveFreeBytes: this.options.reserveFreeBytes,
        emitLog: (level, event, fields = {}) => this.emitLog(level, event, fields),
      },
    );
  }

  private createGenerationLifecycle(): GenerationLifecycle {
    return new GenerationLifecycle(this.storageRoot!, this.db!, {
      staleDeleteAfterMs: this.options.staleDeleteAfterMs,
      emitLog: (level, event, fields = {}) => this.emitLog(level, event, fields),
    });
  }

  /**
   * Every blob path the current sync may serve or still needs: the active generation's
   * blobs, blobs awaiting their `staleDeleteAfterMs` grace period, and the paths the
   * staged manifest's assets resolve to (which covers blobs adopted from failed syncs).
   */
  private collectReferencedBlobPaths(
    currentAssets: GenerationAssetRow[],
    stagedAssets: GenerationAssetRow[],
    manifestAssetMap: Map<string, FlatManifest["assets"][number]>,
  ): Set<string> {
    const referenced = new Set<string>();
    for (const row of currentAssets) {
      if (row.relativePath) {
        referenced.add(normalizeStoredRelativePath(row.relativePath));
      }
    }
    for (const relativePath of this.db!.getPendingDeletionRelativePaths()) {
      referenced.add(normalizeStoredRelativePath(relativePath));
    }
    for (const row of stagedAssets) {
      // Prefer the path already resolved for this staged asset (a reused or
      // adopted blob): it is what the database row and the eventual active
      // generation point at, which is not always the manifest-computed path.
      // Assets still queued for download have no relativePath yet, so fall
      // back to their download destination derived from the manifest.
      if (row.relativePath) {
        referenced.add(normalizeStoredRelativePath(row.relativePath));
        continue;
      }
      const manifestAsset = manifestAssetMap.get(row.assetKey);
      if (manifestAsset) {
        referenced.add(
          normalizeStoredRelativePath(
            blobRelativePath({
              assetKey: row.assetKey,
              version: manifestAsset.version,
              fileName: manifestAsset.fileName,
            }),
          ),
        );
      }
    }
    return referenced;
  }

  /**
   * Deletes blobs nothing references anymore — leftovers from failed syncs whose
   * assets the current manifest no longer contains. Failed-sync rollback keeps
   * blobs on disk (see {@link runSync}), so without this sweep they would
   * accumulate unbounded; `staleDeleteAfterMs` only covers blobs that were once
   * committed. Runs before storage limits are enforced so stale leftovers cannot
   * wedge a sync against `maxCacheBytes`.
   */
  private pruneUnreferencedBlobs(referencedRelativePaths: Set<string>): void {
    const blobsRoot = join(this.storageRoot!, "blobs");
    let prunedCount = 0;
    for (const absolutePath of listFilesRecursively(blobsRoot)) {
      const relativePath = normalizeStoredRelativePath(relative(this.storageRoot!, absolutePath));
      if (referencedRelativePaths.has(relativePath)) {
        continue;
      }

      rmSync(absolutePath, { force: true });
      pruneEmptyParents(absolutePath, this.storageRoot!);
      prunedCount += 1;
    }

    if (prunedCount > 0) {
      this.emitLog("debug", "unreferenced_blobs_pruned", { pruned_count: prunedCount });
    }
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
    if (this.logHandler == null && !this.defaultDevelopmentConsole) {
      return;
    }

    const threshold = LOG_LEVEL_WEIGHT[this.effectiveLogLevel];
    if (LOG_LEVEL_WEIGHT[level] < threshold) {
      return;
    }

    const entry: MediaCacheLogEvent = {
      timestamp: new Date(this.deps.now()).toISOString(),
      level,
      event,
      service: "rockhall-electron-offline-content",
      component: "media-cache",
      ...fields,
    };

    if (this.logHandler != null) {
      try {
        this.logHandler(entry);
      } catch {
        // Consumer loggers must not break cache behavior.
      }
      return;
    }

    writeDefaultDevelopmentConsoleLog(level, entry, this.logFormat);
  }
}

function normalizeLoggingOptions(logging: MediaCacheOptions["logging"]): {
  onLog: MediaCacheLogHandler | null;
  level: MediaCacheLogLevel | undefined;
  format: MediaCacheLogFormat;
} {
  if (logging?.onLog != null && logging.format !== undefined) {
    throw new Error(
      "MediaCacheOptions.logging.format cannot be set when logging.onLog is provided.",
    );
  }

  const format = logging?.format;
  if (format !== undefined && format !== "english" && format !== "json") {
    throw new Error(
      `Invalid MediaCacheOptions.logging.format: expected "english" | "json", received ${JSON.stringify(format)}`,
    );
  }

  return {
    onLog: logging?.onLog ?? null,
    level: logging?.level,
    format: format ?? "english",
  };
}

function writeDefaultDevelopmentConsoleLog(
  level: MediaCacheLogLevel,
  entry: MediaCacheLogEvent,
  format: MediaCacheLogFormat,
): void {
  const line = formatMediaCacheConsoleLine(entry, format);
  switch (level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.log(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
    default:
      console.log(line);
  }
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

function getResolvedVersionFromPath(relativePath: string): string | null {
  const parts = relativePath.split(/[\\/]/);
  return parts.length >= 4 ? decodeURIComponent(parts.at(-2)!) : null;
}

async function resolveElectronAppPath(name: MediaCacheAppPath): Promise<string> {
  const electron = await import("electron");
  return electron.app.getPath(name);
}

async function resolveStorageRoot(
  input: MediaCacheOptions["storagePath"],
  resolveAppPath: RuntimeDependencies["resolveAppPath"],
): Promise<string> {
  const storagePath = parseWithSchema(mediaCacheStoragePathSchema, input, "storage path");
  const root = await resolveAppPath(storagePath.appPath);
  return join(root, ...(storagePath.segments ?? []));
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
