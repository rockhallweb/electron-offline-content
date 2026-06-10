import { EventEmitter } from "node:events";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { IpcMain, Session } from "electron";
import { MEDIA_CACHE_IPC } from "../shared/ipc.js";
import { validateFlatManifest } from "../shared/normalize.js";
import { normalizeStem } from "../shared/stem.js";
import {
  DataValidationError,
  StoreExpiredError,
  StoreValidationError,
  StorageLimitError,
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
import { MediaCacheDatabase } from "./database.js";
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
  effectiveReserveFreeBytes,
  type AssetDownloadTarget,
  type QueuedAssetDownloadTarget,
} from "./asset-download.js";
import {
  GenerationLifecycle,
  normalizeStoredRelativePath,
  pruneEmptyParents,
} from "./generation-lifecycle.js";

export { DEFAULT_RESERVE_FREE_BYTES, effectiveReserveFreeBytes } from "./asset-download.js";

const requireElectron = createRequire(process.execPath);

const DEFAULT_STALE_DELETE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SYNC_HISTORY_LIMIT = 50;
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
    return this.db!.getAsset(hashedKey);
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
    return this.db!.listByIndex(validatedIndexName, validatedValue, validatedPagination);
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
    return this.db!.findByFileStem(normalizeStem(validatedStem), validatedPagination);
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

    const fetchFile =
      options?.fetchFile ??
      (async (request: Request, filePath: string) => createFileResponse(filePath, request));

    session.protocol.handle("media", async (request) => {
      const parsed = new URL(request.url);
      const parts = parsed.pathname.split("/").filter(Boolean);

      if (parsed.hostname !== "asset" || parts.length !== 1) {
        return new Response("Not found", { status: 404 });
      }

      let assetKey: string;
      try {
        assetKey = decodeURIComponent(parts[0]);
      } catch {
        return new Response("Not found", { status: 404 });
      }

      const target = this.db!.getProtocolAssetTarget(assetKey);

      if (!target) {
        this.emitLog("debug", "protocol_request_not_found", {
          asset_key: assetKey,
          method: request.method,
        });
        return new Response("Not found", { status: 404 });
      }

      if (!target.absolutePath || !existsSync(target.absolutePath)) {
        this.emitLog("debug", "protocol_request_file_missing", {
          asset_key: assetKey,
          method: request.method,
        });
        return new Response("Not found", { status: 404 });
      }

      this.emitLog("debug", "protocol_request_local_resolved", {
        asset_key: assetKey,
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

    const electron = options?.ipcMain ? null : await importElectron();
    const ipcMain = options?.ipcMain ?? electron?.ipcMain;
    if (!ipcMain || typeof ipcMain.handle !== "function") {
      this.emitLog("debug", "ipc_attach_skipped", {
        reason: "ipc_main_unavailable",
      });
      return;
    }

    ipcMain.handle(MEDIA_CACHE_IPC.getStatus, async () => this.getStatus());
    ipcMain.handle(MEDIA_CACHE_IPC.syncNow, async () => this.syncNow());
    ipcMain.handle(MEDIA_CACHE_IPC.getAsset, async (_event, key: AssetKeyInput) =>
      this.getAsset(key),
    );
    ipcMain.handle(
      MEDIA_CACHE_IPC.listByIndex,
      async (_event, indexName: string, value: string, pagination?: PaginationInput) =>
        this.listByIndex(indexName, value, pagination),
    );
    ipcMain.handle(
      MEDIA_CACHE_IPC.findByFileStem,
      async (_event, stem: string, pagination?: PaginationInput) =>
        this.findByFileStem(stem, pagination),
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

    this.db = new MediaCacheDatabase(this.storageRoot, {
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
      const manifest = validateFlatManifest(store._serialize());
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

        for (const queuedDownload of downloads) {
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
          const { relativePath, fallbackMimeType } =
            await this.createAssetDownloader().downloadAsset(download, (chunkBytes) => {
              stats.bytesDownloaded += chunkBytes;
              this.updateProgress((progress) => ({
                ...progress,
                bytesDownloaded: stats.bytesDownloaded,
              }));
            });
          this.db!.setAssetDownloadState(
            stagedGenerationId,
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
    const estimatedBlobBytes = downloads.reduce(
      (sum, download) => sum + (download.byteLength ?? 0),
      0,
    );
    const estimatedRemainingDownloadBytes = downloads.reduce(
      (sum, download) => sum + this.createAssetDownloader().remainingDownloadBytes(download),
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

    const stats = await this.deps.statfs(this.storageRoot!);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const reserve = effectiveReserveFreeBytes(this.options.reserveFreeBytes);
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

  private async ensureFileSpaceCommit(): Promise<void> {
    await this.createAssetDownloader().ensureFileSpaceCommit();
  }

  private cleanupObsoletePartialDownloads(downloads: QueuedAssetDownloadTarget[]): void {
    this.createAssetDownloader().cleanupObsoletePartialDownloads(downloads);
  }

  private createAssetDownloader(): AssetDownloader {
    return new AssetDownloader(this.storageRoot!, this.deps, {
      reserveFreeBytes: this.options.reserveFreeBytes,
      emitLog: (level, event, fields = {}) => this.emitLog(level, event, fields),
    });
  }

  private createGenerationLifecycle(): GenerationLifecycle {
    return new GenerationLifecycle(this.storageRoot!, this.db!, {
      emitLog: (level, event, fields = {}) => this.emitLog(level, event, fields),
    });
  }

  private markRemovedAssetsForDeletion(
    previousGenerationId: number,
    stagedGenerationId: number,
  ): void {
    const previousAssets = this.db!.getGenerationAssets(previousGenerationId);
    const nextAssets = new Map(
      this.db!.getGenerationAssets(stagedGenerationId).map((row) => [
        row.assetKey,
        row.relativePath,
      ]),
    );
    const deleteAfterMs =
      this.deps.now() + (this.options.staleDeleteAfterMs ?? DEFAULT_STALE_DELETE_MS);

    let markedCount = 0;
    for (const row of previousAssets) {
      const nextRelativePath = nextAssets.get(row.assetKey);
      if (row.relativePath && nextRelativePath !== row.relativePath) {
        this.db!.markPendingDeletion(
          row.assetKey,
          row.relativePath,
          previousGenerationId,
          createPendingDeletionKey(row.assetKey, row.relativePath),
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
      const absolutePath = join(
        this.storageRoot!,
        normalizeStoredRelativePath(deletion.relativePath),
      );
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

function createPendingDeletionKey(assetKey: string, relativePath: string): string {
  return JSON.stringify([assetKey, relativePath]);
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
