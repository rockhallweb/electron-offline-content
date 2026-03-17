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
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IpcMain, Session } from "electron";
import { MEDIA_CACHE_IPC } from "../shared/ipc.js";
import { normalizeManifest, type NormalizedManifest } from "../shared/normalize.js";
import { normalizeStem } from "../shared/stem.js";
import {
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
import { MediaCacheDatabase, type SyncRunStats } from "./database.js";
import { defaultStorageRoot } from "./default-storage.js";

const DEFAULT_STALE_DELETE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SYNC_HISTORY_LIMIT = 50;
const LOG_LEVEL_WEIGHT: Record<MediaCacheLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface DownloadTarget {
  namespace: string;
  itemId: string;
  assetId: string;
  request: DownloadRequest;
  fileName: string;
  resolvedVersion: string;
  byteLength?: number;
  logicalKey: string;
}

interface RuntimeDependencies {
  fetchImpl: typeof globalThis.fetch;
  now: () => number;
  randomUUID: () => string;
}

interface RegisterProtocolOptions {
  session?: Session;
  fetchFile?: (request: Request, filePath: string) => Promise<Response>;
}

interface AttachIpcOptions {
  ipcMain?: IpcMain;
}

export interface MediaCacheMain {
  start(): Promise<void>;
  syncNow(): Promise<void>;
  getStatus(): Promise<MediaCacheStatus>;
  getItem(namespace: string, id: string): Promise<ResolvedMediaContentItem | null>;
  listNamespace(
    namespace: string,
    pagination?: PaginationInput,
  ): Promise<{ items: ResolvedMediaContentItem[]; nextCursor: string | null }>;
  listNamespaceTree(
    prefix: string,
    pagination?: PaginationInput,
  ): Promise<{ items: ResolvedMediaContentItem[]; nextCursor: string | null }>;
  findByFileStem(
    stem: string,
    options?: PaginationInput & { namespace?: string },
  ): Promise<Awaited<ReturnType<MediaCacheBridge["findByFileStem"]>>>;
  registerProtocol(options?: RegisterProtocolOptions): Promise<void>;
  attachIpc(options?: AttachIpcOptions): Promise<void>;
}

export async function registerMediaCacheProtocolSchemes(): Promise<void> {
  const { protocol } = await import("electron");
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
}

export function createMediaCache(options: MediaCacheOptions): MediaCacheMain {
  return new MediaCache(options);
}

export class MediaCache implements MediaCacheMain {
  private readonly events = new EventEmitter();
  private readonly deps: RuntimeDependencies;
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
      randomUUID: deps?.randomUUID ?? randomUUID,
    };
    this.status = {
      phase: "idle",
      activeGenerationId: null,
      progress: null,
      lastRun: null,
      error: null,
      updatedAt: this.deps.now(),
    };
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
    await this.ensureInitialized();
    return this.db!.getItem(namespace, id);
  }

  async listNamespace(namespace: string, pagination?: PaginationInput) {
    await this.ensureInitialized();
    return this.db!.listNamespace(namespace, pagination);
  }

  async listNamespaceTree(prefix: string, pagination?: PaginationInput) {
    await this.ensureInitialized();
    return this.db!.listNamespaceTree(prefix, pagination);
  }

  async findByFileStem(stem: string, options?: PaginationInput & { namespace?: string }) {
    await this.ensureInitialized();
    return this.db!.findByFileStem(normalizeStem(stem), options?.namespace, options);
  }

  async registerProtocol(options?: RegisterProtocolOptions): Promise<void> {
    await this.ensureInitialized();
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

      const [namespace, itemId, assetId] = parts.map((part) => decodeURIComponent(part));
      const absolutePath = this.db!.getAssetAbsolutePath(namespace, itemId, assetId);

      if (!absolutePath || !existsSync(absolutePath)) {
        this.emitLog("debug", "protocol_request_missing", {
          namespace,
          item_id: itemId,
          asset_id: assetId,
          method: request.method,
        });
        return new Response("Not found", { status: 404 });
      }

      this.emitLog("debug", "protocol_request_resolved", {
        namespace,
        item_id: itemId,
        asset_id: assetId,
        method: request.method,
        range: request.headers.get("range"),
      });
      return fetchFile(request, absolutePath);
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

    this.db = new MediaCacheDatabase(this.storageRoot);
    const storedStatus = this.db.loadStatus();
    if (storedStatus) {
      this.status = storedStatus;
    }
    this.status.activeGenerationId = this.db.getActiveGenerationId();
    this.emitLog("info", "cache_initialized", {
      storage_root: this.storageRoot,
      active_generation_id: this.status.activeGenerationId,
    });
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
        if (
          activeRow?.relativePath &&
          existsSync(join(this.storageRoot!, activeRow.relativePath))
        ) {
          const currentVersion = getResolvedVersionFromPath(activeRow.relativePath);
          const nextVersion = manifestAsset.asset.resolvedVersion;
          if (currentVersion === nextVersion) {
            this.db!.setAssetRelativePath(
              stagedGenerationId,
              row.namespace,
              row.itemId,
              row.assetId,
              activeRow.relativePath,
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
          logicalKey: logicalKey(row.namespace, row.itemId, row.assetId),
        });
      }

      this.emitLog("info", "sync_diffed", {
        run_id: runId,
        total_assets: stagedAssets.length,
        download_count: downloads.length,
        skipped_assets: stats.skippedAssets,
      });

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
        const relativePath = await this.downloadAsset(download, (chunkBytes) => {
          stats.bytesDownloaded += chunkBytes;
          this.updateProgress((progress) => ({
            ...progress,
            bytesDownloaded: stats.bytesDownloaded,
          }));
        });
        this.db!.setAssetRelativePath(
          stagedGenerationId,
          download.namespace,
          download.itemId,
          download.assetId,
          relativePath,
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
          this.options.onSyncFailure === "throw"
            ? "error"
            : this.db!.getActiveGenerationId()
              ? "ready"
              : "error",
        activeGenerationId: this.db!.getActiveGenerationId(),
        progress: null,
        lastRun: summary,
        error: serialized,
      });

      if (this.options.onSyncFailure === "throw") {
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
    const estimatedDownloadBytes = downloads.reduce(
      (sum, download) => sum + (download.byteLength ?? 0),
      0,
    );

    if (this.options.maxCacheBytes !== undefined) {
      const currentBytes = this.currentBytesOnDisk(join(this.storageRoot!, "blobs"));
      if (currentBytes + estimatedDownloadBytes > this.options.maxCacheBytes) {
        this.emitLog("warn", "storage_limit_exceeded", {
          current_bytes: currentBytes,
          estimated_download_bytes: estimatedDownloadBytes,
          max_cache_bytes: this.options.maxCacheBytes,
        });
        throw new StorageLimitError(
          `Estimated cache size ${currentBytes + estimatedDownloadBytes} exceeds maxCacheBytes ${this.options.maxCacheBytes}.`,
        );
      }
    }

    const stats = await statfs(this.storageRoot!);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const reserve = this.options.reserveFreeBytes ?? 0;
    if (availableBytes - estimatedDownloadBytes < reserve) {
      this.emitLog("warn", "storage_reserve_violation", {
        available_bytes: availableBytes,
        estimated_download_bytes: estimatedDownloadBytes,
        reserve_free_bytes: reserve,
      });
      throw new StorageLimitError(
        `Estimated download size ${estimatedDownloadBytes} leaves less than reserveFreeBytes ${reserve}.`,
      );
    }
  }

  private async downloadAsset(
    download: DownloadTarget,
    onChunk: (chunkBytes: number) => void,
  ): Promise<string> {
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
    mkdirSync(join(this.storageRoot!, "temp"), { recursive: true });

    const tempPath = join(this.storageRoot!, "temp", `${this.deps.randomUUID()}.part`);

    try {
      const response = await this.deps.fetchImpl(download.request.url, {
        method: download.request.method ?? "GET",
        headers: download.request.headers,
      });

      if (!response.ok || !response.body) {
        this.emitLog("warn", "asset_download_rejected", {
          namespace: download.namespace,
          item_id: download.itemId,
          asset_id: download.assetId,
          status: response.status,
          status_text: response.statusText,
          url: download.request.url,
        });
        throw new SyncFailureError(
          `Download failed for ${download.namespace}/${download.itemId}/${download.assetId}: ${response.status} ${response.statusText}`,
        );
      }

      const nodeStream = Readable.fromWeb(
        response.body as unknown as NodeReadableStream<Uint8Array>,
      );
      const writeStream = createWriteStream(tempPath, { flags: "wx" });

      nodeStream.on("data", (chunk) => {
        onChunk((chunk as Buffer).byteLength);
      });

      await pipeline(nodeStream, writeStream);
      await this.ensureFileSpaceCommit(tempPath);
      mkdirSync(dirname(destinationPath), { recursive: true });
      rmSync(destinationPath, { force: true });
      renameSyncSafe(tempPath, destinationPath);
      return destinationRelativePath;
    } catch (error) {
      if (existsSync(tempPath)) {
        await unlink(tempPath).catch(() => undefined);
      }
      if (isNoSpaceError(error)) {
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
      throw error;
    }
  }

  private async ensureFileSpaceCommit(tempPath: string): Promise<void> {
    const stats = await statfs(this.storageRoot!);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const reserve = this.options.reserveFreeBytes ?? 0;
    const tempSize = statSync(tempPath).size;
    if (availableBytes - tempSize < reserve) {
      throw new StorageLimitError(`Committing download would violate reserveFreeBytes ${reserve}.`);
    }
  }

  private markRemovedAssetsForDeletion(
    previousGenerationId: number,
    stagedGenerationId: number,
  ): void {
    const previousAssets = this.db!.getGenerationAssets(previousGenerationId);
    const nextAssets = new Set(
      this.db!.getGenerationAssets(stagedGenerationId).map((row) =>
        logicalKey(row.namespace, row.itemId, row.assetId),
      ),
    );
    const deleteAfterMs =
      this.deps.now() + (this.options.staleDeleteAfterMs ?? DEFAULT_STALE_DELETE_MS);

    let markedCount = 0;
    for (const row of previousAssets) {
      const key = logicalKey(row.namespace, row.itemId, row.assetId);
      if (!nextAssets.has(key) && row.relativePath) {
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

    this.db!.deletePendingDeletions(expired.map((item) => item.logicalKey));
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

function pruneEmptyParents(pathToFile: string, storageRoot: string): void {
  let current = dirname(pathToFile);
  while (current.startsWith(storageRoot) && current !== storageRoot) {
    if (existsSync(current) && readdirSync(current).length === 0) {
      rmSync(current, { recursive: false, force: true });
      current = dirname(current);
      continue;
    }
    break;
  }
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
