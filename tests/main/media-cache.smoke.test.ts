import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { statfs as statfsAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  DEFAULT_RESERVE_FREE_BYTES,
  disableMediaCacheStorageRootLockForTests,
  effectiveReserveFreeBytes,
  enableMediaCacheStorageRootLockForTests,
  resetMediaCacheStorageRootLocksForTests,
} from "../../src/main/media-cache.js";
import type { MediaCacheMain } from "../../src/main/index.js";
import { validateFlatManifest } from "../../src/shared/normalize.js";
import {
  DataValidationError,
  StoreExpiredError,
  StoreValidationError,
  StorageLimitError,
  StorageOwnershipError,
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
  collectFiles,
  blobPathFor,
  buildTestStore,
  createStorageRoot,
  electronSupportsProtocolRegistration,
  mimeManifestStore,
  resetMediaCacheProtocolRegistrationStateForTests,
  type TestMediaCacheOptions,
} from "./helpers/media-cache-test-shared.js";

type StubStatFs = Awaited<ReturnType<typeof statfsAsync>>;

type RegisterProtocolOptions = NonNullable<Parameters<MediaCacheMain["registerProtocol"]>[0]>;

const emptyStore = buildTestStore({
  snapshotId: "reserve-tests",
  assets: [],
});

describe("store validation", () => {
  it("preserves a valid store expiresAt timestamp", () => {
    const manifest = validateFlatManifest(
      buildTestStore({
        expiresAt: "2026-04-06T12:30:00.000Z",
        assets: [],
      })._serialize(),
    );

    expect(manifest.expiresAt).toBe("2026-04-06T12:30:00.000Z");
  });

  it("rejects an invalid store expiresAt timestamp", () => {
    expect(() =>
      validateFlatManifest(
        buildTestStore({
          expiresAt: "2026-04-06 12:30:00",
          assets: [],
        })._serialize(),
      ),
    ).toThrow(StoreValidationError);
  });
});

describe("effectiveReserveFreeBytes", () => {
  it("uses DEFAULT_RESERVE_FREE_BYTES when the option is omitted", () => {
    expect(effectiveReserveFreeBytes(undefined)).toBe(DEFAULT_RESERVE_FREE_BYTES);
  });

  it("preserves explicit zero (no headroom)", () => {
    expect(effectiveReserveFreeBytes(0)).toBe(0);
  });

  it("preserves an explicit positive value", () => {
    expect(effectiveReserveFreeBytes(42_000)).toBe(42_000);
  });
});

describe("reserveFreeBytes enforcement with default reserve", () => {
  it("enforceStorageLimits throws when omitted reserve would be violated (stub statfs)", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "media-cache-reserve-default-"));
    const byteLength = 1000;
    const cache = new MediaCache(
      {
        storageRoot,
        resolveStore: () => emptyStore,
      },
      {
        sleep: async () => undefined,
        statfs: async (path) => {
          const base = await statfsAsync(path);
          return {
            ...base,
            bsize: 1n,
            bavail: BigInt(DEFAULT_RESERVE_FREE_BYTES - 1 + byteLength),
          } as unknown as StubStatFs;
        },
      },
    );

    await (cache as unknown as { ensureInitialized(): Promise<void> }).ensureInitialized();

    await expect(
      (
        cache as unknown as {
          enforceStorageLimits(
            downloads: Array<{
              assetKey: string;
              fileName: string;
              version: string;
              byteLength?: number;
            }>,
          ): Promise<void>;
        }
      ).enforceStorageLimits([
        {
          assetKey: "n/i/a",
          fileName: "f.bin",
          version: "v1",
          byteLength,
        },
      ]),
    ).rejects.toThrow(StorageLimitError);
  });

  it("enforceStorageLimits passes when free space after download stays at or above default reserve", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "media-cache-reserve-default-"));
    const byteLength = 5000;
    const cache = new MediaCache(
      {
        storageRoot,
        resolveStore: () => emptyStore,
      },
      {
        sleep: async () => undefined,
        statfs: async (path) => {
          const base = await statfsAsync(path);
          return {
            ...base,
            bsize: 1n,
            bavail: BigInt(DEFAULT_RESERVE_FREE_BYTES + byteLength),
          } as unknown as StubStatFs;
        },
      },
    );

    await (cache as unknown as { ensureInitialized(): Promise<void> }).ensureInitialized();

    await expect(
      (
        cache as unknown as {
          enforceStorageLimits(
            downloads: Array<{
              assetKey: string;
              fileName: string;
              version: string;
              byteLength?: number;
            }>,
          ): Promise<void>;
        }
      ).enforceStorageLimits([
        {
          assetKey: "n/i/a",
          fileName: "f.bin",
          version: "v1",
          byteLength,
        },
      ]),
    ).resolves.toBeUndefined();
  });

  it("ensureFileSpaceCommit throws when free space is below default reserve (stub statfs)", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "media-cache-reserve-commit-"));
    const cache = new MediaCache(
      {
        storageRoot,
        resolveStore: () => emptyStore,
      },
      {
        sleep: async () => undefined,
        statfs: async (path) => {
          const base = await statfsAsync(path);
          return {
            ...base,
            bsize: 1n,
            bavail: BigInt(DEFAULT_RESERVE_FREE_BYTES - 1),
          } as unknown as StubStatFs;
        },
      },
    );

    await (cache as unknown as { ensureInitialized(): Promise<void> }).ensureInitialized();

    await expect(
      (
        cache as unknown as {
          ensureFileSpaceCommit(): Promise<void>;
        }
      ).ensureFileSpaceCommit(),
    ).rejects.toThrow(StorageLimitError);
  });

  it("ensureFileSpaceCommit allows commit when free space equals default reserve (stub statfs)", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "media-cache-reserve-commit-ok-"));
    const cache = new MediaCache(
      {
        storageRoot,
        resolveStore: () => emptyStore,
      },
      {
        sleep: async () => undefined,
        statfs: async (path) => {
          const base = await statfsAsync(path);
          return {
            ...base,
            bsize: 1n,
            bavail: BigInt(DEFAULT_RESERVE_FREE_BYTES),
          } as unknown as StubStatFs;
        },
      },
    );

    await (cache as unknown as { ensureInitialized(): Promise<void> }).ensureInitialized();

    await expect(
      (
        cache as unknown as {
          ensureFileSpaceCommit(): Promise<void>;
        }
      ).ensureFileSpaceCommit(),
    ).resolves.toBeUndefined();
  });
});

describe("media cache sync and queries (smoke)", () => {
  let fixture: Awaited<ReturnType<typeof createMediaCacheTestFixture>>;
  let baseUrl = "";
  let requestCounts: Record<string, number>;
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
    store = fixture.createDefaultStore();
  });

  it("syncs a store, supports index queries, and finds file stems", async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveStore: () => store,
    });

    await cache.start();

    const asset = await cache.getAsset("nature/forest/main");
    expect(asset?.url).toBe(`media://asset/${encodeURIComponent("nature/forest/main")}`);
    expect(asset?.mimeType).toBe("video/mp4");
    const status = await cache.getStatus();
    expect(status.storageRoot).toBe(storageRoot);

    const indexList = await cache.listByIndex("mimeType", "video/mp4", { limit: 10 });
    expect(indexList.items.map((entry) => entry.key)).toContain("nature/forest/main");

    const fileStem = await cache.findByFileStem("flower", { limit: 10 });
    expect(fileStem.items).toHaveLength(1);
    expect(fileStem.items[0]?.asset.key).toBe("nature.flowerVideos/rose/main");
  });

  it("start() orchestrates protocol registration, IPC attach, then sync", async () => {
    const cache = createMediaCache({
      storageRoot: createStorageRoot(),
      resolveStore: () => store,
    });
    const registerSpy = vi.spyOn(cache, "registerProtocol");
    const attachSpy = vi.spyOn(cache, "attachIpc");
    const syncSpy = vi.spyOn(cache, "syncNow");

    await cache.start();

    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy.mock.invocationCallOrder[0]).toBeLessThan(
      attachSpy.mock.invocationCallOrder[0]!,
    );
    expect(attachSpy.mock.invocationCallOrder[0]).toBeLessThan(
      syncSpy.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects a second cache instance on the same storageRoot in the same process", async () => {
    try {
      enableMediaCacheStorageRootLockForTests();
      const storageRoot = createStorageRoot();
      const first = new RawMediaCache({
        storageRoot,
        resolveStore: () => store,
      });
      const second = new RawMediaCache({
        storageRoot,
        resolveStore: () => store,
      });

      await expect(first.syncNow()).resolves.toBeUndefined();
      await expect(second.syncNow()).rejects.toThrow(StorageOwnershipError);
      await expect(second.syncNow()).rejects.not.toThrow(
        new RegExp(`already in use by process ${process.pid}`),
      );
    } finally {
      disableMediaCacheStorageRootLockForTests();
    }
  });

  it("allows different storageRoots to operate independently", async () => {
    try {
      enableMediaCacheStorageRootLockForTests();
      const first = new RawMediaCache({
        storageRoot: createStorageRoot(),
        resolveStore: () => store,
      });
      const second = new RawMediaCache({
        storageRoot: createStorageRoot(),
        resolveStore: () => store,
      });

      await expect(first.syncNow()).resolves.toBeUndefined();
      await expect(second.syncNow()).resolves.toBeUndefined();
    } finally {
      disableMediaCacheStorageRootLockForTests();
    }
  });

  it("retains storageRoot ownership when start() fails", async () => {
    try {
      enableMediaCacheStorageRootLockForTests();
      const storageRoot = createStorageRoot();
      const failingCache = new RawMediaCache({
        storageRoot,
        onSyncFailure: "throw",
        resolveStore: async () => {
          throw new Error("store unavailable");
        },
      });
      const succeedingCache = new RawMediaCache({
        storageRoot,
        resolveStore: () => store,
      });

      await expect(failingCache.start()).rejects.toThrow("store unavailable");
      await expect(succeedingCache.syncNow()).rejects.toThrow(StorageOwnershipError);
    } finally {
      disableMediaCacheStorageRootLockForTests();
    }
  });

  it("disables passthrough by default when devPassthrough is not set", async () => {
    for (const k of Object.keys(requestCounts)) {
      delete requestCounts[k];
    }
    const cache = new RawMediaCache({
      storageRoot: createStorageRoot(),
      onSyncFailure: "throw",
      resolveStore: () => store,
    });

    await cache.start();

    expect(requestCounts["/main.mp4"]).toBe(1);
    expect((await cache.getAsset("nature/forest/main"))?.url).toBe(
      `media://asset/${encodeURIComponent("nature/forest/main")}`,
    );
    expect((await cache.getStatus()).lastRun?.stats.downloadedAssets).toBe(4);
  });

  it("enables passthrough when devPassthrough is omitted and NODE_ENV is development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    try {
      for (const k of Object.keys(requestCounts)) {
        delete requestCounts[k];
      }
      const logs: MediaCacheLogEvent[] = [];
      const cache = new RawMediaCache({
        storageRoot: createStorageRoot(),
        onSyncFailure: "throw",
        logging: {
          onLog: (e) => {
            logs.push(e);
          },
        },
        resolveStore: () => store,
      });

      await cache.start();

      expect(requestCounts["/main.mp4"]).toBeUndefined();
      expect((await cache.getAsset("nature/forest/main"))?.url).toBe(`${baseUrl}/main.mp4`);
      expect((await cache.getStatus()).lastRun?.stats.downloadedAssets).toBe(0);
      expect(logs.find((e) => e.event === "dev_passthrough_active")).toMatchObject({
        level: "info",
        event: "dev_passthrough_active",
        source: "node_env",
        node_env: "development",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets explicit devPassthrough override the default", async () => {
    const passthroughLogs: MediaCacheLogEvent[] = [];
    const passthroughCache = new RawMediaCache({
      storageRoot: createStorageRoot(),
      devPassthrough: true,
      onSyncFailure: "throw",
      logging: {
        onLog: (e) => {
          passthroughLogs.push(e);
        },
      },
      resolveStore: () => store,
    });

    await passthroughCache.start();
    expect(passthroughLogs.find((e) => e.event === "dev_passthrough_active")).toMatchObject({
      level: "info",
      event: "dev_passthrough_active",
      source: "option",
    });
    expect(requestCounts["/main.mp4"]).toBeUndefined();

    for (const k of Object.keys(requestCounts)) {
      delete requestCounts[k];
    }
    const offlineCache = new RawMediaCache({
      storageRoot: createStorageRoot(),
      devPassthrough: false,
      onSyncFailure: "throw",
      resolveStore: () => store,
    });

    await offlineCache.start();
    expect(requestCounts["/main.mp4"]).toBe(1);
  });

  it("commits metadata without downloading assets when passthrough is enabled", async () => {
    const storageRoot = createStorageRoot();
    const cache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      onSyncFailure: "throw",
      resolveStore: () => store,
    });

    await cache.start();

    expect(requestCounts["/main.mp4"]).toBeUndefined();
    expect(requestCounts["/poster.jpg"]).toBeUndefined();

    const asset = await cache.getAsset("nature/forest/main");
    expect(asset?.url).toBe(`${baseUrl}/main.mp4`);
    expect((await cache.getStatus()).lastRun?.stats).toEqual({
      totalAssets: 4,
      downloadedAssets: 0,
      skippedAssets: 4,
      bytesDownloaded: 0,
    });

    store = buildTestStore({
      snapshotId: "passthrough-v2",
      assets: [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "main.mp4",
          source: {
            url: `${baseUrl}/main.mp4`,
          },
        },
      ],
    });

    await cache.syncNow();

    expect(requestCounts["/main.mp4"]).toBeUndefined();
    expect((await cache.getAsset("nature/forest/main"))?.version).toBe("v2");
    expect((await cache.getAsset("nature/forest/main"))?.url).toBe(`${baseUrl}/main.mp4`);
  });

  it("fails fast in passthrough mode when store resolution fails", async () => {
    const storageRoot = createStorageRoot();
    const offlineCache = createMediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await offlineCache.start();
    const committedBlobPath = join(
      storageRoot,
      blobPathFor("nature/forest/main", "v1", "main.mp4"),
    );
    expect(existsSync(committedBlobPath)).toBe(true);

    const passthroughCache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      resolveStore: () => {
        throw new Error("store unavailable");
      },
    });

    await expect(passthroughCache.start()).rejects.toThrow("store unavailable");
    expect((await passthroughCache.getStatus()).activeGenerationId).toBeNull();
    expect(existsSync(committedBlobPath)).toBe(false);
  });

  it("skips unchanged downloads and redownloads when the version changes", async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveStore: () => store,
    });

    await cache.start();
    expect(requestCounts["/main.mp4"]).toBe(1);

    await cache.syncNow();
    expect(requestCounts["/main.mp4"]).toBe(1);

    store = buildTestStore({
      snapshotId: "v2",
      assets: [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "main.mp4",
          byteLength: 9,
          source: {
            url: `${baseUrl}/main.mp4`,
          },
        },
      ],
    });

    await cache.syncNow();
    expect(requestCounts["/main.mp4"]).toBe(2);
  });

  it("supports pipe characters in asset keys", async () => {
    const storageRoot = createStorageRoot();
    store = buildTestStore({
      snapshotId: "pipe-ids",
      assets: [
        {
          key: "nature|archive/forest|loop/main|primary",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "main.mp4",
          byteLength: 9,
          source: {
            url: `${baseUrl}/main.mp4`,
          },
        },
      ],
    });

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveStore: () => store,
    });

    await cache.start();
    const asset = await cache.getAsset("nature|archive/forest|loop/main|primary");
    expect(asset?.url).toBe(
      `media://asset/${encodeURIComponent("nature|archive/forest|loop/main|primary")}`,
    );

    const matches = await cache.findByFileStem("main", { limit: 10 });
    expect(matches.items).toHaveLength(1);
    expect(matches.items[0]?.asset.key).toBe("nature|archive/forest|loop/main|primary");
  });

  it("marks removed assets for deletion instead of deleting them immediately", async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();
    const initialBlobRoot = join(storageRoot, "blobs");
    const filesBefore = collectFiles(initialBlobRoot);
    expect(filesBefore.length).toBeGreaterThan(0);

    store = buildTestStore({
      snapshotId: "empty",
      assets: [],
    });

    await cache.syncNow();
    const filesAfter = collectFiles(initialBlobRoot);
    expect(filesAfter).toEqual(filesBefore);
    const asset = await cache.getAsset("nature/forest/main");
    expect(asset).toBeNull();
  });

  it("serves the last committed snapshot on sync failure by default", async () => {
    const storageRoot = createStorageRoot();
    const cache = createNoSleepCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    store = buildTestStore({
      snapshotId: "broken",
      assets: [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "broken.mp4",
          byteLength: 6,
          source: {
            url: `${baseUrl}/broken.mp4`,
          },
        },
      ],
    });

    await expect(cache.syncNow()).resolves.toBeUndefined();
    const asset = await cache.getAsset("nature/forest/main");
    expect(asset?.version).toBe("v1");
    const status = await cache.getStatus();
    expect(status.error?.code).toBe("SYNC_FAILURE");
  });

  it("throws on sync failure when configured", async () => {
    const storageRoot = createStorageRoot();
    const cache = createNoSleepCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveStore: () => store,
    });

    await cache.start();

    store = buildTestStore({
      snapshotId: "broken",
      assets: [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "broken.mp4",
          byteLength: 6,
          source: {
            url: `${baseUrl}/broken.mp4`,
          },
        },
      ],
    });

    await expect(cache.syncNow()).rejects.toThrow("Download failed");
    const asset = await cache.getAsset("nature/forest/main");
    expect(asset?.version).toBe("v1");
  });

  it("fails before downloading when store expiresAt is already in the past", async () => {
    const storageRoot = createStorageRoot();
    const currentNow = Date.parse("2026-04-06T12:30:01.000Z");
    const cache = new MediaCache(
      {
        storageRoot,
        onSyncFailure: "throw",
        resolveStore: () =>
          buildTestStore({
            snapshotId: "expired-before-download",
            expiresAt: "2026-04-06T12:30:00.000Z",
            assets: [
              {
                key: "nature/forest/main",
                version: "v1",
                mimeType: "video/mp4",
                fileName: "main.mp4",
                byteLength: 9,
                source: {
                  url: `${baseUrl}/main.mp4`,
                },
              },
            ],
          }),
      },
      {
        now: () => currentNow,
        sleep: async () => undefined,
      },
    );

    await expect(cache.start()).rejects.toThrow(StoreExpiredError);
    expect(requestCounts["/main.mp4"] ?? 0).toBe(0);

    const status = await cache.getStatus();
    expect(status.phase).toBe("error");
    expect(status.error?.code).toBe("STORE_EXPIRED");
  });

  it("preserves normal download failure behavior when store expiresAt is omitted", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache(
      {
        storageRoot,
        onSyncFailure: "throw",
        resolveStore: () =>
          buildTestStore({
            snapshotId: "broken-without-expiry",
            assets: [
              {
                key: "nature/forest/main",
                version: "v1",
                mimeType: "video/mp4",
                fileName: "nonretryable.mp4",
                byteLength: 6,
                source: {
                  url: `${baseUrl}/nonretryable.mp4`,
                },
              },
            ],
          }),
      },
      {
        now: () => 1_000,
        sleep: async () => undefined,
      },
    );

    await expect(cache.start()).rejects.toThrow("Download failed");
    expect(requestCounts["/nonretryable.mp4"] ?? 0).toBe(1);

    const status = await cache.getStatus();
    expect(status.error?.code).toBe("SYNC_FAILURE");
  });

  it("retries retryable HTTP failures and does not retry non-retryable 4xx failures", async () => {
    const retryableRoot = createStorageRoot();
    const retryableCache = createNoSleepCache({
      storageRoot: retryableRoot,
      resolveStore: () =>
        buildTestStore({
          snapshotId: "retry-once",
          assets: [
            {
              key: "nature/forest/main",
              version: "v1",
              mimeType: "video/mp4",
              fileName: "retry-once.mp4",
              byteLength: "retry-success".length,
              source: {
                url: `${baseUrl}/retry-once.mp4`,
              },
            },
          ],
        }),
    });

    await retryableCache.start();
    expect(requestCounts["/retry-once.mp4"]).toBe(2);

    const nonRetryableRoot = createStorageRoot();
    const nonRetryableCache = createNoSleepCache({
      storageRoot: nonRetryableRoot,
      onSyncFailure: "throw",
      resolveStore: () =>
        buildTestStore({
          snapshotId: "nonretryable",
          assets: [
            {
              key: "nature/forest/main",
              version: "v1",
              mimeType: "video/mp4",
              fileName: "nonretryable.mp4",
              byteLength: 1,
              source: {
                url: `${baseUrl}/nonretryable.mp4`,
              },
            },
          ],
        }),
    });

    await expect(nonRetryableCache.start()).rejects.toThrow("Download failed");
    expect(requestCounts["/nonretryable.mp4"]).toBe(1);
  });

  it("registers a protocol handler that resolves committed files only", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    const handler = await createProtocolHandler(cache, {
      fetchFile: async (_request, filePath) => new Response(readFileSync(filePath, "utf8")),
    });

    const response = await handler(
      new Request(`media://asset/${encodeURIComponent("nature/forest/main")}`),
    );
    expect(await response.text()).toBe("video-one");

    const missing = await handler(
      new Request(`media://asset/${encodeURIComponent("nature/forest/missing")}`),
    );
    expect(missing.status).toBe(404);
  });

  it("skips media:// protocol registration in passthrough mode", async () => {
    const storageRoot = createStorageRoot();
    const cache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      resolveStore: () => store,
    });

    await cache.start();
    expect(requestCounts["/main.mp4"]).toBeUndefined();

    let registered = false;
    const fakeSession = {
      protocol: {
        handle: () => {
          registered = true;
        },
      },
    } as unknown as RegisterProtocolOptions["session"];
    await cache.registerProtocol({ session: fakeSession });

    expect(registered).toBe(false);
    expect(requestCounts["/main.mp4"]).toBeUndefined();
  });

  it("throws when assetBaseUrl is set without devPassthrough", () => {
    expect(
      () =>
        new RawMediaCache({
          storageRoot: createStorageRoot(),
          devPassthrough: false,
          assetBaseUrl: "https://cdn.example.com",
          resolveStore: () => store,
        }),
    ).toThrow("assetBaseUrl has no effect when devPassthrough is false");
  });

  it("throws when logging.format is not english or json", () => {
    expect(
      () =>
        new MediaCache({
          storageRoot: createStorageRoot(),
          logging: {
            // @ts-expect-error intentional invalid option for runtime validation
            format: "structured",
          },
          resolveStore: () => store,
        }),
    ).toThrow("Invalid MediaCacheOptions.logging.format");
  });

  it("uses logging.format for the built-in development console sink", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "false");
    try {
      new RawMediaCache({
        storageRoot: createStorageRoot(),
        devPassthrough: true,
        logging: {
          format: "json",
        },
        resolveStore: () => store,
      });

      expect(consoleLog).toHaveBeenCalled();
      const jsonLine = consoleLog.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes(" dev_passthrough_active "));
      expect(jsonLine).toBeTypeOf("string");
      const jsonPayload = jsonLine!.slice(jsonLine!.indexOf("{"));
      expect(JSON.parse(jsonPayload)).toMatchObject({
        level: "info",
        event: "dev_passthrough_active",
      });
    } finally {
      consoleLog.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("throws when logging.format is combined with logging.onLog", () => {
    expect(
      () =>
        new MediaCache({
          storageRoot: createStorageRoot(),
          logging: {
            onLog: () => undefined,
            // @ts-expect-error intentional invalid combination for discriminated logging config
            format: "json",
          },
          resolveStore: () => store,
        }),
    ).toThrow("MediaCacheOptions.logging.format cannot be set when logging.onLog is provided.");
  });

  it("rejects removed flat logging options at the type level", () => {
    const options: TestMediaCacheOptions = {
      storageRoot: createStorageRoot(),
      resolveStore: () => store,
    };
    expect(options.resolveStore).toBeTypeOf("function");
    type LegacyFlatLog = "logLevel" | "logFormat";
    type ShouldRejectLegacyKeys = LegacyFlatLog extends keyof TestMediaCacheOptions ? never : true;
    const _assertNoLegacyTopLevelLogOptions: ShouldRejectLegacyKeys = true;
    void _assertNoLegacyTopLevelLogOptions;
  });

  it("emits dev_passthrough_ignores_sync_failure_mode when both devPassthrough and serve-last-snapshot are set", () => {
    const logs: MediaCacheLogEvent[] = [];
    new RawMediaCache({
      storageRoot: createStorageRoot(),
      devPassthrough: true,
      onSyncFailure: "serve-last-snapshot",
      logging: {
        onLog: (e) => logs.push(e),
      },
      resolveStore: () => store,
    });
    expect(logs.some((e) => e.event === "dev_passthrough_ignores_sync_failure_mode")).toBe(true);
    expect(logs.find((e) => e.event === "dev_passthrough_ignores_sync_failure_mode")).toMatchObject(
      { configured_mode: "serve-last-snapshot" },
    );
  });

  it("rejects invalid assetBaseUrl values", () => {
    const create = (assetBaseUrl: string) => () =>
      new RawMediaCache({
        storageRoot: createStorageRoot(),
        devPassthrough: true,
        assetBaseUrl,
        resolveStore: () => store,
      });

    expect(create("https://user:pass@example.test")).toThrow(
      "assetBaseUrl must not include credentials.",
    );
    expect(create("https://assets.example.test/path")).toThrow(
      "assetBaseUrl must be an origin without a path.",
    );
    expect(create("https://assets.example.test?token=abc")).toThrow(
      "assetBaseUrl must not include a query string or hash fragment.",
    );
    expect(create("https://assets.example.test#hash")).toThrow(
      "assetBaseUrl must not include a query string or hash fragment.",
    );
    expect(create("https//cdn.example.com")).toThrow(
      'assetBaseUrl is not a valid URL: "https//cdn.example.com"',
    );
  });

  it("accepts assetBaseUrl null and uses store URLs as-is in passthrough mode", async () => {
    const storageRoot = createStorageRoot();
    const cache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      assetBaseUrl: null,
      resolveStore: () => store,
    });

    await cache.start();

    const asset = await cache.getAsset("nature/forest/main");
    expect(asset?.url).toBe(`${baseUrl}/main.mp4`);
  });

  it("serves byte ranges for committed video assets", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();
    const handler = await createProtocolHandler(cache);

    const response = await handler(
      new Request(`media://asset/${encodeURIComponent("nature/forest/main")}`, {
        headers: {
          range: "bytes=0-4",
        },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes 0-4/9");
    expect(await response.text()).toBe("video");
  });

  it("serves HEAD responses for committed assets", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();
    const handler = await createProtocolHandler(cache);

    const response = await handler(
      new Request(`media://asset/${encodeURIComponent("nature/forest/main")}`, {
        method: "HEAD",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("9");
    expect(await response.text()).toBe("");
  });

  it("maps the current MIME type set for committed assets", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveStore: () => mimeManifestStore(baseUrl),
    });

    await cache.start();
    const handler = await createProtocolHandler(cache);

    const cases = [
      ["mime/types/main", "video/mp4"],
      ["mime/types/webm", "video/webm"],
      ["mime/types/mov", "video/quicktime"],
      ["mime/types/jpg", "image/jpeg"],
      ["mime/types/jpeg", "image/jpeg"],
      ["mime/types/png", "image/png"],
      ["mime/types/gif", "image/gif"],
      ["mime/types/webp", "image/webp"],
      ["mime/types/vtt", "text/vtt"],
      ["mime/types/srt", "application/x-subrip"],
      ["mime/types/mp3", "audio/mpeg"],
      ["mime/types/wav", "audio/wav"],
      ["mime/types/html", "text/html; charset=utf-8"],
      ["mime/types/txt", "text/plain; charset=utf-8"],
      ["mime/types/json", "application/json; charset=utf-8"],
      ["mime/types/pdf", "application/pdf"],
    ] as const;

    for (const [assetKey, expectedMime] of cases) {
      const response = await handler(new Request(`media://asset/${encodeURIComponent(assetKey)}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(expectedMime);
    }
  });

  it("handles range edge cases for committed assets", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();
    const handler = await createProtocolHandler(cache);

    const assetUrl = `media://asset/${encodeURIComponent("nature/forest/main")}`;

    const cases = [
      {
        name: "full response without range",
        request: new Request(assetUrl),
        expectedStatus: 200,
        expectedBody: "video-one",
        expectedContentRange: null,
      },
      {
        name: "bounded range",
        request: new Request(assetUrl, {
          headers: { range: "bytes=0-4" },
        }),
        expectedStatus: 206,
        expectedBody: "video",
        expectedContentRange: "bytes 0-4/9",
      },
      {
        name: "open ended range",
        request: new Request(assetUrl, {
          headers: { range: "bytes=5-" },
        }),
        expectedStatus: 206,
        expectedBody: "-one",
        expectedContentRange: "bytes 5-8/9",
      },
      {
        name: "suffix range",
        request: new Request(assetUrl, {
          headers: { range: "bytes=-5" },
        }),
        expectedStatus: 206,
        expectedBody: "o-one",
        expectedContentRange: "bytes 4-8/9",
      },
      {
        name: "invalid range",
        request: new Request(assetUrl, {
          headers: { range: "bytes=99-100" },
        }),
        expectedStatus: 416,
        expectedBody: "",
        expectedContentRange: "bytes */9",
      },
      {
        name: "unsupported multi-range",
        request: new Request(assetUrl, {
          headers: { range: "bytes=0-1,3-4" },
        }),
        expectedStatus: 416,
        expectedBody: "",
        expectedContentRange: "bytes */9",
      },
    ] as const;

    for (const testCase of cases) {
      const response = await handler(testCase.request);
      expect({
        name: testCase.name,
        status: response.status,
        acceptRanges: response.headers.get("accept-ranges"),
        contentRange: response.headers.get("content-range"),
        body: await response.text(),
      }).toEqual({
        name: testCase.name,
        status: testCase.expectedStatus,
        acceptRanges: "bytes",
        contentRange: testCase.expectedContentRange,
        body: testCase.expectedBody,
      });
    }
  });

  it("emits structured log events through the consumer callback", async () => {
    const storageRoot = createStorageRoot();
    const logs: MediaCacheLogEvent[] = [];
    const cache = createMediaCache({
      storageRoot,
      logging: {
        level: "debug",
        onLog: (entry) => {
          logs.push(entry);
        },
      },
      resolveStore: () => store,
    });

    await cache.start();

    expect(logs.some((entry) => entry.event === "cache_initialized")).toBe(true);
    expect(logs.some((entry) => entry.event === "cache_storage_location")).toBe(true);
    expect(logs.find((entry) => entry.event === "cache_storage_location")).toMatchObject({
      level: "info",
      storage_root: storageRoot,
    });
    expect(logs.some((entry) => entry.event === "sync_started")).toBe(true);
    expect(logs.some((entry) => entry.event === "sync_completed")).toBe(true);
    expect(logs.some((entry) => entry.event === "asset_download_started")).toBe(true);
    expect(logs.every((entry) => entry.service === "rockhallweb-electron-offline-content")).toBe(
      true,
    );
    expect(logs.every((entry) => entry.component === "media-cache")).toBe(true);
  });

  it("requires storagePath configuration", () => {
    expect(
      () =>
        new MediaCache({
          resolveStore: () =>
            buildTestStore({
              snapshotId: "missing-storage-path",
              assets: [],
            }),
        }),
    ).toThrow(DataValidationError);
  });

  it("ignores invalid stored status snapshots and logs a warning", async () => {
    const storageRoot = createStorageRoot();
    const initialCache = new MediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await initialCache.start();

    const initialDb = (
      initialCache as unknown as {
        db: {
          close(): void;
          db: { prepare(sql: string): { run(...args: unknown[]): void } };
        };
      }
    ).db;
    initialDb.db
      .prepare(
        `UPDATE status_snapshot
         SET status_json = ?
         WHERE scope_type = 'global' AND scope_key = '*'`,
      )
      .run('{"phase":42}');
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
      activeGenerationId: expect.any(Number),
      progress: null,
      error: null,
    });
    expect(logs.some((entry) => entry.event === "status_snapshot_invalid")).toBe(true);
  });

  it("throws DataValidationError for malformed sync run stats JSON", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await (cache as unknown as { ensureInitialized(): Promise<void> }).ensureInitialized();

    const db = (
      cache as unknown as {
        db: {
          createSyncRun(now: number): number;
          getSyncRun(id: number): unknown;
          db: { prepare(sql: string): { run(...args: unknown[]): void } };
        };
      }
    ).db;
    const runId = db.createSyncRun(1);
    db.db
      .prepare("UPDATE sync_runs SET stats_json = ? WHERE id = ?")
      .run('{"totalAssets":"bad"}', runId);

    expect(() => db.getSyncRun(runId)).toThrow(DataValidationError);
  });

  it("throws DataValidationError for malformed committed asset metadata JSON", async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    const db = (
      cache as unknown as {
        db: {
          getActiveGenerationId(): number | null;
          db: { prepare(sql: string): { run(...args: unknown[]): void } };
        };
      }
    ).db;
    const activeGenerationId = db.getActiveGenerationId();
    expect(activeGenerationId).not.toBeNull();

    db.db
      .prepare(
        `UPDATE assets
         SET metadata_json = ?
         WHERE generation_id = ? AND asset_key = ?`,
      )
      .run("{", activeGenerationId, "nature/forest/main");

    await expect(cache.getAsset("nature/forest/main")).rejects.toThrow(DataValidationError);
  });

  it("rejects invalid cursor payloads before querying the database", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveStore: () => store,
    });

    await cache.start();

    const invalidBase64Cursor = "!not-base64!";
    const invalidDecodedCursor = Buffer.from(JSON.stringify({ index: -1 }), "utf8").toString(
      "base64url",
    );

    await expect(
      cache.listByIndex("mimeType", "video/mp4", {
        cursor: invalidBase64Cursor,
      }),
    ).rejects.toThrow(DataValidationError);
    await expect(
      cache.listByIndex("mimeType", "video/mp4", {
        cursor: invalidDecodedCursor,
      }),
    ).rejects.toThrow(DataValidationError);
    const emptyCache = createMediaCache({
      storageRoot: createStorageRoot(),
      resolveStore: () => store,
    });
    await expect(
      emptyCache.findByFileStem("main", {
        cursor: invalidDecodedCursor,
      }),
    ).rejects.toThrow(DataValidationError);
    await expect(
      cache.listByIndex(
        "mimeType",
        "video/mp4",
        null as unknown as { limit?: number; cursor?: string },
      ),
    ).resolves.toMatchObject({
      items: expect.any(Array),
    });
    await expect(
      cache.findByFileStem("main", null as unknown as { limit?: number; cursor?: string }),
    ).resolves.toMatchObject({
      items: expect.any(Array),
    });

    const handlers = await createIpcHandlers(cache);
    const db = (
      cache as unknown as {
        db: {
          listByIndex(indexName: string, value: string, pagination?: unknown): unknown;
        };
      }
    ).db;
    const originalListByIndex = db.listByIndex.bind(db);
    let dbCalled = false;
    db.listByIndex = (indexName: string, value: string, pagination?: unknown) => {
      dbCalled = true;
      return originalListByIndex(indexName, value, pagination);
    };

    await expect(
      handlers.get(MEDIA_CACHE_IPC.listByIndex)!("mimeType", "video/mp4", {
        limit: "10",
      } as unknown as {
        limit: number;
      }),
    ).rejects.toThrow(DataValidationError);
    await expect(
      handlers.get(MEDIA_CACHE_IPC.listByIndex)!("mimeType", "video/mp4", { limit: -5 }),
    ).rejects.toThrow(DataValidationError);
    expect(dbCalled).toBe(false);
    await expect(
      handlers.get(MEDIA_CACHE_IPC.listByIndex)!("mimeType", "video/mp4", {
        cursor: null,
      } as unknown as { cursor?: string }),
    ).resolves.toMatchObject({
      items: expect.any(Array),
    });
    expect(dbCalled).toBe(true);
  });

  it("exposes syncNow over IPC", async () => {
    const cache = createMediaCache({
      storageRoot: createStorageRoot(),
      resolveStore: () => store,
    });
    const syncSpy = vi.spyOn(cache, "syncNow").mockResolvedValue(undefined);
    const handlers = await createIpcHandlers(cache);

    await expect(handlers.get(MEDIA_CACHE_IPC.syncNow)!()).resolves.toBeUndefined();
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects empty string and oversized identifiers with DataValidationError", async () => {
    const cache = createMediaCache({
      storageRoot: createStorageRoot(),
      resolveStore: () => store,
    });
    await cache.start();

    await expect(cache.getAsset("")).rejects.toThrow(DataValidationError);
    await expect(cache.listByIndex("", "video/mp4")).rejects.toThrow(DataValidationError);
    await expect(cache.listByIndex("mimeType", "")).rejects.toThrow(DataValidationError);
    await expect(cache.findByFileStem("")).rejects.toThrow(DataValidationError);

    const long = "x".repeat(2001);
    await expect(cache.getAsset(long)).rejects.toThrow(DataValidationError);
    await expect(cache.listByIndex(long, "video/mp4")).rejects.toThrow(DataValidationError);
    await expect(cache.listByIndex("mimeType", long)).rejects.toThrow(DataValidationError);
    await expect(cache.findByFileStem(long)).rejects.toThrow(DataValidationError);
  });

  it("rejects circular store metadata during sync", async () => {
    const storageRoot = createStorageRoot();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    store = buildTestStore({
      snapshotId: "circular-metadata",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "main.mp4",
          source: { url: `${baseUrl}/main.mp4` },
          metadata: circular as unknown as Record<string, JsonValue>,
        },
      ],
    });

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveStore: () => store,
    });

    await expect(cache.start()).rejects.toThrow("circular");
  });

  it("accepts non-integer store byteLength values", async () => {
    const storageRoot = createStorageRoot();
    store = buildTestStore({
      snapshotId: "fractional-byte-length",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          byteLength: 12.5,
          source: { url: `${baseUrl}/main.mp4` },
        },
      ],
    });

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveStore: () => store,
    });

    await cache.start();
    const asset = await cache.getAsset("nature/forest/main");
    expect(asset?.byteLength).toBe(12.5);
  });

  it.skipIf(!electronSupportsProtocolRegistration)(
    "registers the privileged media scheme at most once for offline mode",
    () => {
      const requireElectron = createRequire(import.meta.url);
      const electron = requireElectron("electron") as typeof import("electron");

      resetMediaCacheProtocolRegistrationStateForTests();
      const spy = vi
        .spyOn(electron.protocol, "registerSchemesAsPrivileged")
        .mockImplementation(() => undefined);

      try {
        new RawMediaCache({
          storageRoot: createStorageRoot(),
          devPassthrough: false,
          resolveStore: async () => buildTestStore({ assets: [] }),
        });
        new RawMediaCache({
          storageRoot: createStorageRoot(),
          devPassthrough: false,
          resolveStore: async () => buildTestStore({ assets: [] }),
        });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    },
  );
});
