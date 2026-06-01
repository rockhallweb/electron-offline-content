import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { StorageLimitError } from "../shared/errors.js";
import type { JsonValue, MediaCacheLogLevel } from "../shared/types.js";
import type { QueuedAssetDownloadTarget } from "./asset-download.js";

/** When `reserveFreeBytes` is omitted, preserve this much free space on the cache volume (1 GiB). */
export const DEFAULT_RESERVE_FREE_BYTES = 1024 * 1024 * 1024;

/**
 * Effective minimum free bytes: explicit option, or {@link DEFAULT_RESERVE_FREE_BYTES} when omitted.
 * `0` means no reserved headroom.
 * @internal
 */
export function effectiveReserveFreeBytes(explicit: number | undefined): number {
  return explicit === undefined ? DEFAULT_RESERVE_FREE_BYTES : explicit;
}

type StatFsResult = Awaited<ReturnType<typeof import("node:fs/promises").statfs>>;

export type StorageBudgetLogHandler = (
  level: MediaCacheLogLevel,
  event: string,
  fields?: Record<string, JsonValue | undefined>,
) => void;

export interface StorageBudgetDependencies {
  statfs: (path: string) => Promise<StatFsResult>;
}

export class StorageBudget {
  constructor(
    private readonly storageRoot: string,
    private readonly deps: StorageBudgetDependencies,
    private readonly options: {
      maxCacheBytes?: number;
      reserveFreeBytes?: number;
      emitLog: StorageBudgetLogHandler;
    },
  ) {}

  async assertPreflight(downloads: QueuedAssetDownloadTarget[]): Promise<void> {
    const estimatedBlobBytes = downloads.reduce(
      (sum, download) => sum + (download.byteLength ?? 0),
      0,
    );
    const estimatedRemainingDownloadBytes = downloads.reduce(
      (sum, download) => sum + this.remainingDownloadBytes(download),
      0,
    );

    if (this.options.maxCacheBytes !== undefined) {
      const currentBytes = currentBytesOnDisk(join(this.storageRoot, "blobs"));
      if (currentBytes + estimatedBlobBytes > this.options.maxCacheBytes) {
        this.options.emitLog("warn", "storage_limit_exceeded", {
          current_bytes: currentBytes,
          estimated_download_bytes: estimatedBlobBytes,
          max_cache_bytes: this.options.maxCacheBytes,
        });
        throw new StorageLimitError(
          `Estimated cache size ${currentBytes + estimatedBlobBytes} exceeds maxCacheBytes ${this.options.maxCacheBytes}.`,
        );
      }
    }

    const availableBytes = await this.availableBytes();
    const reserve = effectiveReserveFreeBytes(this.options.reserveFreeBytes);
    if (availableBytes - estimatedRemainingDownloadBytes < reserve) {
      this.options.emitLog("warn", "storage_reserve_violation", {
        available_bytes: availableBytes,
        estimated_download_bytes: estimatedRemainingDownloadBytes,
        reserve_free_bytes: reserve,
      });
      throw new StorageLimitError(
        `Estimated download size ${estimatedRemainingDownloadBytes} leaves less than reserveFreeBytes ${reserve}.`,
      );
    }
  }

  async assertCommit(): Promise<void> {
    const availableBytes = await this.availableBytes();
    const reserve = effectiveReserveFreeBytes(this.options.reserveFreeBytes);
    if (availableBytes < reserve) {
      throw new StorageLimitError(`Committing download would violate reserveFreeBytes ${reserve}.`);
    }
  }

  private remainingDownloadBytes(download: QueuedAssetDownloadTarget): number {
    const expectedBytes = download.byteLength ?? 0;
    const partialBytes = partialDownloadBytes(this.storageRoot, download);
    return Math.max(expectedBytes - partialBytes, 0);
  }

  private async availableBytes(): Promise<number> {
    const stats = await this.deps.statfs(this.storageRoot);
    return Number(stats.bavail) * Number(stats.bsize);
  }
}

export function partialDownloadPath(
  storageRoot: string,
  download: QueuedAssetDownloadTarget,
): string {
  return join(
    storageRoot,
    "temp",
    sanitizeSegment(download.assetKey),
    sanitizeSegment(download.version),
    `${sanitizeSegment(download.fileName)}.part`,
  );
}

function partialDownloadBytes(storageRoot: string, download: QueuedAssetDownloadTarget): number {
  const tempPath = partialDownloadPath(storageRoot, download);
  return existsSync(tempPath) ? statSync(tempPath).size : 0;
}

function currentBytesOnDisk(directory: string): number {
  if (!existsSync(directory)) {
    return 0;
  }

  const stats = statSync(directory);
  if (stats.isFile()) {
    return stats.size;
  }

  return readdirSync(directory).reduce(
    (sum, entry) => sum + currentBytesOnDisk(join(directory, entry)),
    0,
  );
}

function sanitizeSegment(segment: string): string {
  return encodeURIComponent(segment);
}
