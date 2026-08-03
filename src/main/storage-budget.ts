import { readdirSync as fsReaddirSync, statSync as fsStatSync, type Stats } from "node:fs";
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

export type StorageBudgetLogHandler = (
  level: MediaCacheLogLevel,
  event: string,
  fields?: Record<string, JsonValue | undefined>,
) => void;

/**
 * Narrow adapter the budget calls to discount bytes already present in a Partial Download
 * for the given Asset Download target.
 */
export interface PartialDownloadByteSource {
  partialDownloadBytes(download: QueuedAssetDownloadTarget): number;
}

type StatFsResult = Awaited<ReturnType<typeof import("node:fs/promises").statfs>>;

/**
 * Injectable disk ops for {@link bytesOnDisk}. Tests stub these to simulate entries that vanish
 * between enumeration and stat (TOCTOU).
 * @internal
 */
export interface BytesOnDiskOps {
  statSync: (path: string, options: { throwIfNoEntry: false }) => Stats | undefined;
  readdirSync: (path: string) => string[];
}

export interface StorageBudgetDependencies {
  statfs: (path: string) => Promise<StatFsResult>;
  /** @internal Optional override so tests can simulate vanishing entries mid-scan. */
  disk?: BytesOnDiskOps;
}

/**
 * Owns cache-size and free-space policy for Asset Downloads: max cache bytes, reserve free
 * bytes, current Blob bytes, and Partial Download discounts. Both the preflight download
 * budget check and the commit-time reserve check throw {@link StorageLimitError} from here.
 */
export class StorageBudget {
  constructor(
    private readonly storageRoot: string,
    private readonly partialDownloads: PartialDownloadByteSource,
    private readonly deps: StorageBudgetDependencies,
    private readonly options: {
      maxCacheBytes?: number;
      reserveFreeBytes?: number;
      emitLog: StorageBudgetLogHandler;
    },
  ) {}

  /** Expected bytes still to transfer for a download after discounting its Partial Download. */
  remainingDownloadBytes(download: QueuedAssetDownloadTarget): number {
    const expectedBytes = download.byteLength ?? 0;
    const partialBytes = this.partialDownloads.partialDownloadBytes(download);
    return Math.max(expectedBytes - partialBytes, 0);
  }

  /** Preflight check before downloads start: maxCacheBytes and reserveFreeBytes policy. */
  async ensureDownloadBudget(downloads: QueuedAssetDownloadTarget[]): Promise<void> {
    const estimatedBlobBytes = downloads.reduce(
      (sum, download) => sum + (download.byteLength ?? 0),
      0,
    );
    const estimatedRemainingDownloadBytes = downloads.reduce(
      (sum, download) => sum + this.remainingDownloadBytes(download),
      0,
    );

    if (this.options.maxCacheBytes !== undefined) {
      const currentBytes = bytesOnDisk(join(this.storageRoot, "blobs"), this.deps.disk);
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

  /** Commit-time check before a finished download is renamed into the Blob tree. */
  async ensureCommitReserve(): Promise<void> {
    const availableBytes = await this.availableBytes();
    const reserve = effectiveReserveFreeBytes(this.options.reserveFreeBytes);
    if (availableBytes < reserve) {
      throw new StorageLimitError(`Committing download would violate reserveFreeBytes ${reserve}.`);
    }
  }

  private async availableBytes(): Promise<number> {
    const stats = await this.deps.statfs(this.storageRoot);
    return Number(stats.bavail) * Number(stats.bsize);
  }
}

const defaultDiskOps: BytesOnDiskOps = {
  statSync: (path, options) => fsStatSync(path, options),
  readdirSync: (path) => fsReaddirSync(path),
};

/**
 * Recursive on-disk size of a file or directory tree; 0 when missing or vanished mid-scan.
 * @internal
 */
export function bytesOnDisk(path: string, ops: BytesOnDiskOps = defaultDiskOps): number {
  // Single stat with throwIfNoEntry:false avoids the existsSync→statSync TOCTOU where a
  // concurrent delete between the check and the stat would throw and abort budget evaluation.
  const stats = ops.statSync(path, { throwIfNoEntry: false });
  if (!stats) {
    return 0;
  }

  if (stats.isFile()) {
    return stats.size;
  }

  let entries: string[];
  try {
    entries = ops.readdirSync(path);
  } catch (error) {
    // Directory vanished between the directory stat and readdir.
    if (isEnoentError(error)) {
      return 0;
    }
    throw error;
  }

  return entries.reduce((sum, entry) => sum + bytesOnDisk(join(path, entry), ops), 0);
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
