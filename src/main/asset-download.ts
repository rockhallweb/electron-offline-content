import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { dirname, join } from "node:path";
import { isNoSpaceError, StorageLimitError, SyncFailureError } from "../shared/errors.js";
import type { JsonValue, MediaCacheLogLevel } from "../shared/types.js";

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

export interface QueuedAssetDownloadTarget {
  assetKey: string;
  fileName: string;
  version: string;
  byteLength?: number;
}

export interface AssetDownloadTarget extends QueuedAssetDownloadTarget {
  request: {
    url: string;
    method?: string;
    headers?: HeadersInit;
  };
}

export interface AssetDownloadResult {
  relativePath: string;
  fallbackMimeType: string | null;
}

export interface AssetDownloaderDependencies {
  fetchImpl: typeof globalThis.fetch;
  sleep: (delayMs: number) => Promise<void>;
  statfs: (path: string) => Promise<StatFsResult>;
}

export type AssetDownloadLogHandler = (
  level: MediaCacheLogLevel,
  event: string,
  fields?: Record<string, JsonValue | undefined>,
) => void;

type StatFsResult = Awaited<ReturnType<typeof import("node:fs/promises").statfs>>;

export class AssetDownloader {
  constructor(
    private readonly storageRoot: string,
    private readonly deps: AssetDownloaderDependencies,
    private readonly options: {
      reserveFreeBytes?: number;
      emitLog: AssetDownloadLogHandler;
    },
  ) {}

  remainingDownloadBytes(download: QueuedAssetDownloadTarget): number {
    const expectedBytes = download.byteLength ?? 0;
    const partialBytes = this.partialDownloadBytes(download);
    return Math.max(expectedBytes - partialBytes, 0);
  }

  partialDownloadPath(download: QueuedAssetDownloadTarget): string {
    return join(
      this.storageRoot,
      "temp",
      sanitizeSegment(download.assetKey),
      sanitizeSegment(download.version),
      `${sanitizeSegment(download.fileName)}.part`,
    );
  }

  cleanupObsoletePartialDownloads(downloads: QueuedAssetDownloadTarget[]): void {
    const tempRoot = join(this.storageRoot, "temp");
    if (!existsSync(tempRoot)) {
      return;
    }

    const resumablePaths = new Set(downloads.map((download) => this.partialDownloadPath(download)));
    for (const filePath of listFilesRecursively(tempRoot)) {
      if (!filePath.endsWith(".part") || resumablePaths.has(filePath)) {
        continue;
      }

      rmSync(filePath, { force: true });
      pruneEmptyParents(filePath, this.storageRoot);
    }
  }

  async downloadAsset(
    download: AssetDownloadTarget,
    onChunk: (chunkBytes: number) => void,
  ): Promise<AssetDownloadResult> {
    const destinationRelativePath = join(
      "blobs",
      sanitizeSegment(download.assetKey),
      sanitizeSegment(download.version),
      sanitizeSegment(download.fileName),
    );
    const destinationPath = join(this.storageRoot, destinationRelativePath);

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
          this.options.emitLog("error", "asset_download_storage_failed", {
            asset_key: download.assetKey,
            url: download.request.url,
          });
          throw new StorageLimitError(`Disk is full while downloading ${download.assetKey}.`, {
            cause: error,
          });
        }

        const retryable = isRetryableDownloadError(error);
        if (!retryable) {
          await unlink(tempPath).catch(() => undefined);
          throw error;
        }

        if (attempt === TOTAL_DOWNLOAD_ATTEMPTS - 1) {
          this.options.emitLog("warn", "asset_download_retry_exhausted", {
            asset_key: download.assetKey,
            attempt: attempt + 1,
            partial_path: tempPath,
          });
          break;
        }

        const delayMs = calculateRetryDelay(attempt);
        this.options.emitLog("warn", "asset_download_retry_scheduled", {
          asset_key: download.assetKey,
          attempt: attempt + 1,
          retry_delay_ms: delayMs,
        });
        await this.deps.sleep(delayMs);
      }
    }

    throw lastError;
  }

  async ensureFileSpaceCommit(): Promise<void> {
    const stats = await this.deps.statfs(this.storageRoot);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const reserve = effectiveReserveFreeBytes(this.options.reserveFreeBytes);
    if (availableBytes < reserve) {
      throw new StorageLimitError(`Committing download would violate reserveFreeBytes ${reserve}.`);
    }
  }

  private partialDownloadBytes(download: QueuedAssetDownloadTarget): number {
    const tempPath = this.partialDownloadPath(download);
    return existsSync(tempPath) ? statSync(tempPath).size : 0;
  }

  private async downloadAssetAttempt(
    download: AssetDownloadTarget,
    destinationPath: string,
    destinationRelativePath: string,
    tempPath: string,
    onChunk: (chunkBytes: number) => void,
  ): Promise<AssetDownloadResult> {
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
            `Server rejected range request for ${download.assetKey}.`,
            false,
            response.status,
          );
        }

        restartedWithoutRange = true;
        await unlink(tempPath).catch(() => undefined);
        this.options.emitLog("debug", "asset_download_range_restart", {
          asset_key: download.assetKey,
          resumed_bytes: resumeSize,
          response_status: response.status,
          content_range: response.headers.get("content-range"),
        });
        continue;
      }

      if (!response.ok || !response.body) {
        this.options.emitLog("warn", "asset_download_rejected", {
          asset_key: download.assetKey,
          status: response.status,
          status_text: response.statusText,
          url: download.request.url,
        });
        throw createDownloadError(
          `Download failed for ${download.assetKey}: ${response.status} ${response.statusText}`,
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
            `Server did not honor range request for ${download.assetKey}.`,
            false,
            response.status,
          );
        }

        restartedWithoutRange = true;
        await unlink(tempPath).catch(() => undefined);
        this.options.emitLog("debug", "asset_download_range_restart", {
          asset_key: download.assetKey,
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
      renameSync(tempPath, destinationPath);
      return {
        relativePath: destinationRelativePath,
        fallbackMimeType: normalizeResponseMimeType(response.headers.get("content-type")),
      };
    }
  }
}

function sanitizeSegment(segment: string): string {
  return encodeURIComponent(segment);
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
