import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, statfsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  disableMediaCacheStorageRootLockForTests,
  enableMediaCacheStorageRootLockForTests,
  resetMediaCacheStorageRootLocksForTests,
} from "../../src/main/media-cache.js";
import { normalizeManifest } from "../../src/shared/normalize.js";
import {
  StoreExpiredError,
  StorageOwnershipError,
  StorageLimitError,
} from "../../src/shared/errors.js";
import { MEDIA_CACHE_IPC } from "../../src/shared/ipc.js";
import type { JsonValue, MediaCacheLogEvent } from "../../src/shared/types.js";
import type { MediaStore } from "../../src/main/store.js";
import {
  RawMediaCache,
  MediaCache,
  createMediaCache,
  createMediaCacheTestFixture,
  createNoSleepCache,
  createProtocolHandler,
  createIpcHandlers,
  blobPathFor,
  hashKey,
  partialPathFor,
  createStorageRoot,
  buildTestStore,
  startExternalStorageRootLock,
} from "./helpers/media-cache-test-shared.js";

describe("media cache sync and queries (integration)", () => {
  let fixture: Awaited<ReturnType<typeof createMediaCacheTestFixture>>;
  let baseUrl = "";
  let requestCounts: Record<string, number>;
  let requestRanges: Record<string, string[]>;
  let store: MediaStore;

  beforeAll(async () => {
    fixture = await createMediaCacheTestFixture();
    baseUrl = fixture.baseUrl;
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    disableMediaCacheStorageRootLockForTests();
    resetMediaCacheStorageRootLocksForTests();
    fixture.resetCounters();
    requestCounts = fixture.counters.requestCounts;
    requestRanges = fixture.counters.requestRanges;
    store = fixture.createDefaultStore();
  });

  it("rejects a second process that targets the same storageRoot", async () => {
    try {
      enableMediaCacheStorageRootLockForTests();
      const storageRoot = createStorageRoot();
      const lockHolder = await startExternalStorageRootLock(storageRoot);

      try {
        const cache = new RawMediaCache({
          storageRoot,
          resolveStore: () => store,
        });

        await expect(cache.syncNow()).rejects.toThrow(StorageOwnershipError);
      } finally {
        await lockHolder.stop();
      }
    } finally {
      disableMediaCacheStorageRootLockForTests();
    }
  });

  it("uses assetBaseUrl as an origin override in passthrough mode", async () => {
    const storageRoot = createStorageRoot();
    const storeWithQuerySource = buildTestStore({
      snapshotId: "asset-base-url",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          url: `${baseUrl}/main.mp4?token=abc123`,
        },
      ],
    });

    const passthroughCache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      assetBaseUrl: "https://assets.example.test",
      resolveStore: () => storeWithQuerySource,
    });

    await passthroughCache.start();

    const asset = await passthroughCache.getAsset("nature/forest/main");
    expect(asset?.url).toBe("https://assets.example.test/main.mp4?token=abc123");
  });

  it("emits resolve_asset_base_url_fallback and returns source URL when asset URL cannot be parsed in passthrough mode", async () => {
    const storageRoot = createStorageRoot();
    const logs: MediaCacheLogEvent[] = [];
    const invalidUrlStore = buildTestStore({
      snapshotId: "invalid-url-fallback",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "video.mp4",
          url: `${baseUrl}/main.mp4`,
        },
      ],
    });

    const cache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      assetBaseUrl: "https://assets.example.test",
      logging: {
        level: "debug",
        onLog: (entry) => {
          logs.push(entry);
        },
      },
      resolveStore: () => invalidUrlStore,
    });

    await cache.start();
    const asset = await cache.getAsset("nature/forest/main");

    expect(asset?.url).toBeTruthy();
  });

  it("clears prior local state on passthrough startup", async () => {
    const storageRoot = createStorageRoot();
    const offlineCache = createMediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await offlineCache.start();
    const committedBlobPath = join(
      storageRoot,
      blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4"),
    );
    expect(existsSync(committedBlobPath)).toBe(true);

    const passthroughCache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      resolveStore: () => store,
    });

    await passthroughCache.start();

    expect(existsSync(committedBlobPath)).toBe(false);
    expect((await passthroughCache.getStatus()).activeGenerationId).not.toBeNull();
    expect((await passthroughCache.getAsset("nature/forest/main"))?.url).toBe(
      `${baseUrl}/main.mp4`,
    );
  });

  it("reuses cached assets when stored relative paths use windows separators", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();
    expect(requestCounts["/main.mp4"]).toBe(1);

    const db = (
      cache as unknown as {
        db: {
          getActiveGenerationId(): number | null;
          getGenerationAssets(generationId: number): Array<{
            assetKey: string;
            version: string;
            relativePath: string | null;
            mimeType: string;
            url: string;
          }>;
          setAssetRelativePath(generationId: number, assetKey: string, relativePath: string): void;
        };
      }
    ).db;
    const activeGenerationId = db.getActiveGenerationId();
    expect(activeGenerationId).not.toBeNull();

    const mainAsset = db
      .getGenerationAssets(activeGenerationId!)
      .find((row) => row.assetKey === hashKey("nature/forest/main"));
    expect(mainAsset?.relativePath).toBeTruthy();

    const windowsRelativePath = `blobs\\${hashKey("nature/forest/main")}\\v1\\main.mp4`;
    db.setAssetRelativePath(
      activeGenerationId!,
      hashKey("nature/forest/main"),
      windowsRelativePath,
    );

    await cache.syncNow();
    expect(requestCounts["/main.mp4"]).toBe(1);
  });

  it("preserves JSON.stringify semantics for undefined asset metadata", async () => {
    const storageRoot = createStorageRoot();
    store = buildTestStore({
      snapshotId: "undefined-json-fields",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "main.mp4",
          byteLength: 9,
          url: `${baseUrl}/main.mp4`,
          metadata: {
            keep: "asset",
            drop: undefined,
          } as unknown as Record<string, JsonValue>,
        },
      ],
    });

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveStore: () => store,
    });

    await expect(cache.start()).resolves.toBeUndefined();
    const asset = await cache.getAsset("nature/forest/main");
    expect(asset?.metadata).toEqual({ keep: "asset" });
  });

  it("fails before a later asset download when store expires mid-sync", async () => {
    let currentNow = 1_000;
    const storageRoot = createStorageRoot();
    const requestedUrls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(requestUrl);
      if (requestUrl.endsWith("/main.mp4")) {
        currentNow = 2_000;
        return new Response("video-one", {
          headers: { "content-type": "video/mp4" },
        });
      }
      if (requestUrl.endsWith("/poster.jpg")) {
        return new Response("poster", {
          headers: { "content-type": "image/jpeg" },
        });
      }
      throw new Error(`Unexpected test URL: ${requestUrl}`);
    });
    const cache = new MediaCache(
      {
        storageRoot,
        onSyncFailure: "throw",
        resolveStore: () =>
          buildTestStore({
            snapshotId: "expires-mid-sync",
            expiresAt: new Date(1_500).toISOString(),
            assets: [
              {
                key: "nature/forest/main",
                version: "v1",
                mimeType: "video/mp4",
                fileName: "main.mp4",
                byteLength: "video-one".length,
                url: `${baseUrl}/main.mp4`,
              },
              {
                key: "nature/forest/poster",
                version: "v1",
                mimeType: "image/jpeg",
                fileName: "poster.jpg",
                byteLength: "poster".length,
                url: `${baseUrl}/poster.jpg`,
              },
            ],
          }),
      },
      {
        fetchImpl,
        now: () => currentNow,
        sleep: async () => undefined,
      },
    );

    await expect(cache.start()).rejects.toThrow(StoreExpiredError);
    expect(requestedUrls).toEqual([`${baseUrl}/main.mp4`]);

    const status = await cache.getStatus();
    expect(status.phase).toBe("error");
    expect(status.error?.code).toBe("STORE_EXPIRED");
  });

  it("keeps serving the previous generation when a later store is already expired", async () => {
    let currentNow = 1_000;
    const storageRoot = createStorageRoot();
    const cache = new MediaCache(
      {
        storageRoot,
        resolveStore: () => store,
      },
      {
        now: () => currentNow,
        sleep: async () => undefined,
      },
    );

    await cache.start();

    currentNow = 2_000;
    store = buildTestStore({
      snapshotId: "expired-update",
      expiresAt: new Date(1_500).toISOString(),
      assets: [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "expired-update.mp4",
          byteLength: 12,
          url: `${baseUrl}/expired-update.mp4`,
        },
      ],
    });

    await expect(cache.syncNow()).resolves.toBeUndefined();
    expect(requestCounts["/expired-update.mp4"] ?? 0).toBe(0);
    expect((await cache.getAsset("nature/forest/main"))?.version).toBe("v1");

    const status = await cache.getStatus();
    expect(status.phase).toBe("ready");
    expect(status.activeGenerationId).not.toBeNull();
    expect(status.error?.code).toBe("STORE_EXPIRED");
  });

  it("resumes an existing partial download across cache instances", async () => {
    const storageRoot = createStorageRoot();
    const partialPath = join(
      storageRoot,
      partialPathFor(hashKey("nature/forest/main"), "v1", "resumable.mp4"),
    );
    mkdirSync(join(storageRoot, "temp"), { recursive: true });
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, "resume");

    store = buildTestStore({
      snapshotId: "resume",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "resumable.mp4",
          byteLength: "resume-data".length,
          url: `${baseUrl}/resumable.mp4`,
        },
      ],
    });

    const cache = createNoSleepCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    expect(requestRanges["/resumable.mp4"]).toContain("bytes=6-");
    expect(existsSync(partialPath)).toBe(false);

    const finalPath = join(
      storageRoot,
      blobPathFor(hashKey("nature/forest/main"), "v1", "resumable.mp4"),
    );
    expect(readFileSync(finalPath, "utf8")).toBe("resume-data");
  });

  it("discounts existing partial bytes when enforcing reserveFreeBytes", async () => {
    const storageRoot = createStorageRoot();
    const body = "x".repeat(1_000_000);
    const partialPath = join(
      storageRoot,
      partialPathFor(hashKey("nature/forest/main"), "v1", "reserve-resumable.mp4"),
    );
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, body.slice(0, 990_000));

    store = buildTestStore({
      snapshotId: "reserve-resume",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "reserve-resumable.mp4",
          byteLength: body.length,
          url: `${baseUrl}/reserve-resumable.mp4`,
        },
      ],
    });

    const cache = new MediaCache(
      {
        storageRoot,
        resolveStore: () => store,
      },
      {
        sleep: async () => undefined,
      },
    );

    await (cache as unknown as { ensureInitialized(): Promise<void> }).ensureInitialized();
    const stats = statfsSync(storageRoot);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const reserve = Math.max(0, availableBytes - 500_000);
    expect(availableBytes - body.length).toBeLessThan(reserve);
    expect(availableBytes - (body.length - 990_000)).toBeGreaterThanOrEqual(reserve);
    (
      cache as unknown as {
        options: {
          reserveFreeBytes?: number;
        };
      }
    ).options.reserveFreeBytes = reserve;

    await expect(
      (
        cache as unknown as {
          enforceStorageLimits(
            downloads: Array<{
              assetKey: string;
              version: string;
              fileName: string;
              byteLength?: number;
              url: string;
            }>,
          ): Promise<void>;
        }
      ).enforceStorageLimits([
        {
          assetKey: hashKey("nature/forest/main"),
          version: "v1",
          fileName: "reserve-resumable.mp4",
          byteLength: body.length,
          url: `${baseUrl}/reserve-resumable.mp4`,
        },
      ]),
    ).resolves.toBeUndefined();

    writeFileSync(partialPath, body);
    await expect(
      (
        cache as unknown as {
          ensureFileSpaceCommit(): Promise<void>;
        }
      ).ensureFileSpaceCommit(),
    ).resolves.toBeUndefined();
  });

  it("preserves partial files across retryable HTTP failures during resumed downloads", async () => {
    const storageRoot = createStorageRoot();
    const partialPath = join(
      storageRoot,
      partialPathFor(hashKey("nature/forest/main"), "v1", "resume-retryable.mp4"),
    );
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, "resume");

    store = buildTestStore({
      snapshotId: "resume-retryable",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "resume-retryable.mp4",
          byteLength: "resume-retry-success".length,
          url: `${baseUrl}/resume-retryable.mp4`,
        },
      ],
    });

    const cache = createNoSleepCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    expect(requestRanges["/resume-retryable.mp4"]).toEqual(["bytes=6-", "bytes=6-"]);
    expect(existsSync(partialPath)).toBe(false);

    const finalPath = join(
      storageRoot,
      blobPathFor(hashKey("nature/forest/main"), "v1", "resume-retryable.mp4"),
    );
    expect(readFileSync(finalPath, "utf8")).toBe("resume-retry-success");
  });

  it("restarts from byte zero when a server ignores a range request", async () => {
    const storageRoot = createStorageRoot();
    const partialPath = join(
      storageRoot,
      partialPathFor(hashKey("nature/forest/main"), "v1", "range-ignored.mp4"),
    );
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, "range");

    store = buildTestStore({
      snapshotId: "range-ignored",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "range-ignored.mp4",
          byteLength: "range-ignore".length,
          url: `${baseUrl}/range-ignored.mp4`,
        },
      ],
    });

    const cache = createNoSleepCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    expect(requestCounts["/range-ignored.mp4"]).toBe(2);
    expect(requestRanges["/range-ignored.mp4"]).toEqual(["bytes=5-", ""]);
    expect(existsSync(partialPath)).toBe(false);
  });

  it("restarts from byte zero when a server returns a mismatched content range", async () => {
    const storageRoot = createStorageRoot();
    const partialPath = join(
      storageRoot,
      partialPathFor(hashKey("nature/forest/main"), "v1", "range-mismatch.mp4"),
    );
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, "range");

    store = buildTestStore({
      snapshotId: "range-mismatch",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "range-mismatch.mp4",
          byteLength: "range-mismatch".length,
          url: `${baseUrl}/range-mismatch.mp4`,
        },
      ],
    });

    const cache = createNoSleepCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    expect(requestCounts["/range-mismatch.mp4"]).toBe(2);
    expect(requestRanges["/range-mismatch.mp4"]).toEqual(["bytes=5-", ""]);
    expect(existsSync(partialPath)).toBe(false);

    const finalPath = join(
      storageRoot,
      blobPathFor(hashKey("nature/forest/main"), "v1", "range-mismatch.mp4"),
    );
    expect(readFileSync(finalPath, "utf8")).toBe("range-mismatch");
  });

  it("restarts from byte zero when a server rejects a completed range with 416", async () => {
    const storageRoot = createStorageRoot();
    const body = "range-416";
    const partialPath = join(
      storageRoot,
      partialPathFor(hashKey("nature/forest/main"), "v1", "range-not-satisfiable.mp4"),
    );
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, body);

    store = buildTestStore({
      snapshotId: "range-not-satisfiable",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "range-not-satisfiable.mp4",
          byteLength: body.length,
          url: `${baseUrl}/range-not-satisfiable.mp4`,
        },
      ],
    });

    const cache = createNoSleepCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    expect(requestCounts["/range-not-satisfiable.mp4"]).toBe(2);
    expect(requestRanges["/range-not-satisfiable.mp4"]).toEqual([`bytes=${body.length}-`, ""]);
    expect(existsSync(partialPath)).toBe(false);

    const finalPath = join(
      storageRoot,
      blobPathFor(hashKey("nature/forest/main"), "v1", "range-not-satisfiable.mp4"),
    );
    expect(readFileSync(finalPath, "utf8")).toBe(body);
  });

  it("preserves partial files after exhausting retryable download failures", async () => {
    const storageRoot = createStorageRoot();
    store = buildTestStore({
      snapshotId: "drop-after-two",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "drop-after-two.mp4",
          byteLength: "retry-bytes".length,
          url: `${baseUrl}/drop-after-two.mp4`,
        },
      ],
    });

    const cache = createNoSleepCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveStore: () => store,
    });

    await expect(cache.start()).rejects.toThrow("terminated");
    const partialPath = join(
      storageRoot,
      partialPathFor(hashKey("nature/forest/main"), "v1", "drop-after-two.mp4"),
    );
    expect(existsSync(partialPath)).toBe(true);
    expect(statSync(partialPath).size).toBeGreaterThan(0);
    expect(
      existsSync(
        join(storageRoot, blobPathFor(hashKey("nature/forest/main"), "v1", "drop-after-two.mp4")),
      ),
    ).toBe(false);
  });

  it("cleans up obsolete partial files that no longer match current download targets", async () => {
    const storageRoot = createStorageRoot();
    const obsoletePartialPath = join(
      storageRoot,
      partialPathFor(hashKey("nature/forest/main"), "stale-version", "main.mp4"),
    );
    mkdirSync(join(obsoletePartialPath, ".."), { recursive: true });
    writeFileSync(obsoletePartialPath, "stale-bytes");

    const cache = createNoSleepCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    expect(existsSync(obsoletePartialPath)).toBe(false);
    expect(
      existsSync(join(storageRoot, blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4"))),
    ).toBe(true);
  });

  it("cleans up obsolete partial files while passthrough mode is enabled", async () => {
    const storageRoot = createStorageRoot();
    const obsoletePartialPath = join(
      storageRoot,
      partialPathFor(hashKey("nature/forest/main"), "stale-version", "main.mp4"),
    );
    mkdirSync(join(obsoletePartialPath, ".."), { recursive: true });
    writeFileSync(obsoletePartialPath, "stale-bytes");

    const cache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      resolveStore: () => store,
    });

    await cache.start();

    expect(existsSync(obsoletePartialPath)).toBe(false);
  });

  it("classifies wrapped ENOSPC download failures as storage limit errors", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache(
      {
        storageRoot,
        onSyncFailure: "throw",
        resolveStore: () => store,
      },
      {
        sleep: async () => undefined,
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("x"));
                queueMicrotask(() => {
                  controller.error(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
                });
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "video/mp4" },
            },
          ),
      },
    );

    await expect(cache.start()).rejects.toThrow(StorageLimitError);
    const partialPath = join(
      storageRoot,
      partialPathFor(hashKey("nature/forest/main"), "v1", "main.mp4"),
    );
    expect(existsSync(partialPath)).toBe(false);
  });

  it("cleans up newly staged blob files after a failed sync while keeping the last committed snapshot", async () => {
    const storageRoot = createStorageRoot();
    const cache = createNoSleepCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    store = buildTestStore({
      snapshotId: "cleanup-failed-stage",
      assets: [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "retry-once.mp4",
          byteLength: "retry-success".length,
          url: `${baseUrl}/retry-once.mp4`,
        },
        {
          key: "nature/forest/poster",
          version: "v2",
          mimeType: "image/jpeg",
          fileName: "broken.mp4",
          byteLength: 6,
          url: `${baseUrl}/broken.mp4`,
        },
      ],
    });

    await cache.syncNow();

    expect(
      existsSync(
        join(storageRoot, blobPathFor(hashKey("nature/forest/main"), "v2", "retry-once.mp4")),
      ),
    ).toBe(false);
    expect(
      existsSync(join(storageRoot, blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4"))),
    ).toBe(true);
    expect((await cache.getAsset("nature/forest/main"))?.version).toBe("v1");
  });

  it("cleans up orphaned staged generations on startup while preserving the active snapshot", async () => {
    const storageRoot = createStorageRoot();
    const initialCache = createNoSleepCache({
      storageRoot,
      resolveStore: () => store,
    });

    await initialCache.start();

    const initialDb = (
      initialCache as unknown as {
        db: {
          close(): void;
          getActiveGenerationId(): number | null;
          createStagedGeneration(
            manifest: ReturnType<typeof normalizeManifest>,
            now: number,
          ): number;
          setAssetDownloadState(
            generationId: number,
            assetKey: string,
            relativePath: string,
            fallbackMimeType: string | null,
          ): void;
          listStagedGenerationIds(): number[];
          db: {
            prepare(sql: string): {
              get(...args: unknown[]): { count: number } | undefined;
            };
          };
        };
      }
    ).db;
    const activeGenerationId = initialDb.getActiveGenerationId();
    expect(activeGenerationId).not.toBeNull();

    const orphanStore = buildTestStore({
      snapshotId: "orphaned-stage",
      assets: [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "main.mp4",
          byteLength: "video-one".length,
          url: `${baseUrl}/main.mp4`,
        },
        {
          key: "nature/forest/poster",
          version: "v2",
          mimeType: "image/jpeg",
          fileName: "poster-v2.jpg",
          byteLength: "poster".length,
          url: `${baseUrl}/poster.jpg`,
        },
      ],
    });
    const orphanManifest = normalizeManifest(orphanStore._serialize());
    const stagedGenerationId = initialDb.createStagedGeneration(orphanManifest, 2);
    const reusedMainPath = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
    const orphanPosterPath = blobPathFor(hashKey("nature/forest/poster"), "v2", "poster-v2.jpg");
    initialDb.setAssetDownloadState(
      stagedGenerationId,
      hashKey("nature/forest/main"),
      reusedMainPath,
      "video/mp4",
    );
    initialDb.setAssetDownloadState(
      stagedGenerationId,
      hashKey("nature/forest/poster"),
      orphanPosterPath,
      "image/jpeg",
    );
    const orphanPosterAbsolutePath = join(storageRoot, orphanPosterPath);
    mkdirSync(dirname(orphanPosterAbsolutePath), { recursive: true });
    writeFileSync(orphanPosterAbsolutePath, "orphaned-poster");

    expect(initialDb.listStagedGenerationIds()).toEqual([stagedGenerationId]);
    expect(
      initialDb.db
        .prepare(`SELECT COUNT(*) AS count FROM assets WHERE generation_id = ?`)
        .get(stagedGenerationId)?.count,
    ).toBe(2);
    initialDb.close();

    const logs: MediaCacheLogEvent[] = [];
    const cache = new MediaCache({
      storageRoot,
      logging: {
        level: "warn",
        onLog: (entry) => {
          logs.push(entry);
        },
      },
      resolveStore: () => store,
    });

    const status = await cache.getStatus();
    expect(status).toMatchObject({
      phase: "ready",
      activeGenerationId,
      error: null,
    });
    expect((await cache.getAsset("nature/forest/main"))?.version).toBe("v1");

    const reopenedDb = (
      cache as unknown as {
        db: {
          listStagedGenerationIds(): number[];
          db: {
            prepare(sql: string): {
              get(...args: unknown[]): { count: number } | undefined;
            };
          };
        };
      }
    ).db;
    expect(reopenedDb.listStagedGenerationIds()).toEqual([]);
    expect(
      reopenedDb.db
        .prepare(`SELECT COUNT(*) AS count FROM generations WHERE id = ?`)
        .get(stagedGenerationId)?.count,
    ).toBe(0);
    expect(existsSync(join(storageRoot, reusedMainPath))).toBe(true);
    expect(existsSync(orphanPosterAbsolutePath)).toBe(false);
    expect(
      logs.find((entry) => entry.event === "orphaned_staged_generations_removed"),
    ).toMatchObject({
      level: "warn",
      active_generation_id: activeGenerationId,
      removed_generation_ids: [stagedGenerationId],
      removed_generation_count: 1,
    });
  });

  it("prunes expired deletions before enforcing storage limits", async () => {
    let currentNow = 1_000;
    const storageRoot = createStorageRoot();
    store = buildTestStore({
      snapshotId: "small-initial",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "main.mp4",
          byteLength: 9,
          url: `${baseUrl}/main.mp4`,
        },
      ],
    });
    const cache = new MediaCache(
      {
        storageRoot,
        maxCacheBytes: 15,
        staleDeleteAfterMs: 10,
        resolveStore: () => store,
      },
      {
        now: () => currentNow,
        sleep: async () => undefined,
      },
    );

    await cache.start();

    store = buildTestStore({
      snapshotId: "pending-delete",
      assets: [],
    });
    await cache.syncNow();

    currentNow = 2_000;
    store = buildTestStore({
      snapshotId: "after-prune",
      assets: [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "flower.mp4",
          byteLength: 12,
          url: `${baseUrl}/flower.mp4`,
        },
      ],
    });

    await expect(cache.syncNow()).resolves.toBeUndefined();
    expect(
      existsSync(join(storageRoot, blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4"))),
    ).toBe(false);
    expect(
      existsSync(join(storageRoot, blobPathFor(hashKey("nature/forest/main"), "v2", "flower.mp4"))),
    ).toBe(true);
  });

  it("retains multiple obsolete blob versions until each expires", async () => {
    let currentNow = 1_000;
    const storageRoot = createStorageRoot();
    store = buildTestStore({
      snapshotId: "retain-v1",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "main.mp4",
          byteLength: "video-one".length,
          url: `${baseUrl}/main.mp4`,
        },
      ],
    });

    const cache = new MediaCache(
      {
        storageRoot,
        staleDeleteAfterMs: 1_000,
        resolveStore: () => store,
      },
      {
        now: () => currentNow,
        sleep: async () => undefined,
      },
    );

    await cache.start();

    currentNow = 1_100;
    store = buildTestStore({
      snapshotId: "retain-v2",
      assets: [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "flower.mp4",
          byteLength: "flower-video".length,
          url: `${baseUrl}/flower.mp4`,
        },
      ],
    });
    await cache.syncNow();

    currentNow = 1_200;
    store = buildTestStore({
      snapshotId: "retain-v3",
      assets: [
        {
          key: "nature/forest/main",
          version: "v3",
          mimeType: "video/mp4",
          fileName: "resumable.mp4",
          byteLength: "resume-data".length,
          url: `${baseUrl}/resumable.mp4`,
        },
      ],
    });
    await cache.syncNow();

    const v1Path = join(storageRoot, blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4"));
    const v2Path = join(
      storageRoot,
      blobPathFor(hashKey("nature/forest/main"), "v2", "flower.mp4"),
    );
    const v3Path = join(
      storageRoot,
      blobPathFor(hashKey("nature/forest/main"), "v3", "resumable.mp4"),
    );
    expect(existsSync(v1Path)).toBe(true);
    expect(existsSync(v2Path)).toBe(true);
    expect(existsSync(v3Path)).toBe(true);

    currentNow = 3_000;
    await cache.syncNow();

    expect(existsSync(v1Path)).toBe(false);
    expect(existsSync(v2Path)).toBe(false);
    expect(existsSync(v3Path)).toBe(true);
  });

  it("uses declared mimeType over server content-type", async () => {
    const storageRoot = createStorageRoot();
    store = buildTestStore({
      snapshotId: "mime-precedence",
      assets: [
        {
          key: "nature/fallback/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "mime-manifest.bin",
          byteLength: "mime-manifest".length,
          url: `${baseUrl}/mime-manifest.bin`,
        },
      ],
    });

    const cache = createNoSleepCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    const asset = await cache.getAsset("nature/fallback/main");
    expect(asset?.mimeType).toBe("video/mp4");

    store = buildTestStore({
      snapshotId: "mime-precedence-skip",
      assets: [
        {
          key: "nature/fallback/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "mime-manifest.bin",
          byteLength: "mime-manifest".length,
          url: `${baseUrl}/mime-manifest.bin`,
        },
      ],
    });

    await cache.syncNow();
    expect(requestCounts["/mime-manifest.bin"]).toBe(1);

    const skippedAsset = await cache.getAsset("nature/fallback/main");
    expect(skippedAsset?.mimeType).toBe("video/mp4");
  });

  it("registers a syncNow IPC handler that triggers a sync run", async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    const handlers = await createIpcHandlers(cache);
    const syncNowHandler = handlers.get(MEDIA_CACHE_IPC.syncNow);
    expect(syncNowHandler).toBeTypeOf("function");

    await expect(syncNowHandler!()).resolves.toBeUndefined();
    const status = await cache.getStatus();
    expect(status.lastRun?.status).toBe("success");
    expect(status.activeGenerationId).not.toBeNull();
  });

  it("returns 404 for media:// URLs with malformed percent-encoding in path", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveStore: () => store,
    });
    await cache.start();
    const handler = await createProtocolHandler(cache, {
      fetchFile: async (_request, filePath) => new Response(readFileSync(filePath, "utf8")),
    });

    const malformed = await handler(new Request("media://asset/foo%GG/bar/main"));
    expect(malformed.status).toBe(404);
  });
});
