import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  disableMediaCacheStorageRootLockForTests,
  enableMediaCacheStorageRootLockForTests,
  resetMediaCacheStorageRootLocksForTests,
} from "../../src/main/media-cache.js";
import {
  defineAsset,
  defineItem,
  defineManifest,
  type MediaCacheMain,
} from "../../src/main/index.js";
import { normalizeManifest } from "../../src/shared/normalize.js";
import {
  DataValidationError,
  ManifestExpiredError,
  ManifestValidationError,
  StorageOwnershipError,
} from "../../src/shared/errors.js";
import { MEDIA_CACHE_IPC } from "../../src/shared/ipc.js";
import type { JsonValue, MediaCacheLogEvent, MediaCacheManifest } from "../../src/shared/types.js";
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
  createStorageRoot,
  electronSupportsProtocolRegistration,
  mimeManifest,
  recordManifest,
  resetMediaCacheProtocolRegistrationStateForTests,
  type TestMediaCacheOptions,
} from "./helpers/media-cache-test-shared.js";

type RegisterProtocolOptions = NonNullable<Parameters<MediaCacheMain["registerProtocol"]>[0]>;

describe("manifest normalization", () => {
  it("normalizes record-shaped namespaces into ordered arrays with injected ids", () => {
    const manifest = normalizeManifest({
      namespaces: {
        default: {
          items: {
            "item-1": {
              version: "v1",
              kind: "video",
              assets: {
                main: {
                  role: "primary",
                  kind: "video",
                  source: {
                    url: "https://example.com/file.mp4",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(manifest.namespaces).toHaveLength(1);
    expect(manifest.namespaces[0]?.key).toBe("default");
    expect(manifest.namespaces[0]?.items[0]?.assets[0]?.normalizedFileName).toBe("file.mp4");
  });

  it("prefers explicit fileName over URL-derived defaults", () => {
    const manifest = normalizeManifest({
      namespaces: {
        default: {
          items: {
            "item-1": {
              version: "v1",
              kind: "video",
              assets: {
                main: {
                  role: "primary",
                  kind: "video",
                  fileName: "custom-name.mp4",
                  source: {
                    url: "https://example.com/file.mp4",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(manifest.namespaces[0]?.items[0]?.assets[0]?.normalizedFileName).toBe("custom-name.mp4");
  });

  it("preserves a valid manifest expiresAt timestamp", () => {
    const manifest = normalizeManifest({
      expiresAt: "2026-04-06T12:30:00.000Z",
      namespaces: {
        gallery: { items: {} },
      },
    });

    expect(manifest.expiresAt).toBe("2026-04-06T12:30:00.000Z");
  });

  it("rejects an invalid manifest expiresAt timestamp", () => {
    expect(() =>
      normalizeManifest({
        expiresAt: "2026-04-06 12:30:00",
        namespaces: {},
      }),
    ).toThrow(ManifestValidationError);
  });
});

describe("producer manifest helpers", () => {
  it("validates and returns manifest assets and items", () => {
    const asset = defineAsset({
      role: "primary",
      kind: "video",
      source: {
        url: "https://cdn.example.com/forest.mp4",
      },
    });
    const item = defineItem({
      version: "v1",
      kind: "video",
      assets: { main: asset },
    });
    const manifest = defineManifest({
      namespaces: {
        nature: {
          items: { forest: item },
        },
      },
    });

    expect(manifest.namespaces.nature?.items.forest).toBeDefined();
    expect(manifest.namespaces.nature?.items.forest?.assets.main).toBeDefined();
  });

  it("derives fileName by default and keeps explicit overrides", () => {
    const derivedAsset = defineAsset({
      role: "primary",
      kind: "video",
      source: {
        url: "https://cdn.example.com/videos/forest.mp4",
      },
    });
    expect(derivedAsset.fileName).toBe("forest.mp4");

    const explicitAsset = defineAsset({
      role: "primary",
      kind: "video",
      fileName: "custom-forest.mp4",
      source: {
        url: "https://cdn.example.com/videos/forest.mp4",
      },
    });
    expect(explicitAsset.fileName).toBe("custom-forest.mp4");
  });

  it("throws DataValidationError for invalid producer helper input", () => {
    expect(() =>
      defineAsset({
        role: "primary",
        kind: "video",
        source: {
          url: "not-a-url",
        },
      }),
    ).toThrow(DataValidationError);
  });

  it("defineManifest accepts distinct namespace keys (duplicates cannot appear in object literals)", () => {
    const manifest = defineManifest(
      recordManifest({
        namespaces: [
          { key: "a", items: [] },
          { key: "b", items: [] },
        ],
      }),
    );
    expect(Object.keys(manifest.namespaces).sort()).toEqual(["a", "b"]);
  });
});

describe("media cache sync and queries (smoke)", () => {
  let fixture: Awaited<ReturnType<typeof createMediaCacheTestFixture>>;
  let baseUrl = "";
  let requestCounts: Record<string, number>;
  let manifests: MediaCacheManifest;

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
    manifests = fixture.createDefaultManifests();
  });

  it("syncs a manifest, preserves manifest order, supports tree queries, and finds file stems", async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await cache.start();

    const item = await cache.getItem("nature", "forest");
    expect(item?.title).toBe("Forest");
    expect(item?.assets[0]?.url).toBe("media://asset/nature/forest/main");
    expect(item?.assetsByRole.primary?.id).toBe("main");
    expect(item?.assetsByRole.poster?.id).toBe("poster");
    const status = await cache.getStatus();
    expect(status.storageRoot).toBe(storageRoot);

    const namespaceList = await cache.listNamespace("nature", { limit: 10 });
    expect(namespaceList.items.map((entry) => entry.id)).toEqual(["forest"]);

    const treeList = await cache.listNamespaceTree("nature", { limit: 10 });
    expect(treeList.items.map((entry) => `${entry.namespace}/${entry.id}`)).toEqual([
      "nature/forest",
      "nature.flowerVideos/rose",
    ]);

    const fileStem = await cache.findByFileStem("flower", { limit: 10 });
    expect(fileStem.items).toHaveLength(1);
    expect(fileStem.items[0]?.item.id).toBe("rose");
    expect(fileStem.items[0]?.matchedAssetIds).toEqual(["main"]);
  });

  it("start() orchestrates protocol registration, IPC attach, then sync", async () => {
    const cache = createMediaCache({
      storageRoot: createStorageRoot(),
      resolveManifest: () => manifests,
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
        resolveManifest: () => manifests,
      });
      const second = new RawMediaCache({
        storageRoot,
        resolveManifest: () => manifests,
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
        resolveManifest: () => manifests,
      });
      const second = new RawMediaCache({
        storageRoot: createStorageRoot(),
        resolveManifest: () => manifests,
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
        resolveManifest: async () => {
          throw new Error("manifest unavailable");
        },
      });
      const succeedingCache = new RawMediaCache({
        storageRoot,
        resolveManifest: () => manifests,
      });

      await expect(failingCache.start()).rejects.toThrow("manifest unavailable");
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
      resolveManifest: () => manifests,
    });

    await cache.start();

    expect(requestCounts["/main.mp4"]).toBe(1);
    expect((await cache.getItem("nature", "forest"))?.assets[0]?.url).toBe(
      "media://asset/nature/forest/main",
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
        resolveManifest: () => manifests,
      });

      await cache.start();

      expect(requestCounts["/main.mp4"]).toBeUndefined();
      expect((await cache.getItem("nature", "forest"))?.assets[0]?.url).toBe(`${baseUrl}/main.mp4`);
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
      resolveManifest: () => manifests,
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
      resolveManifest: () => manifests,
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
      resolveManifest: () => manifests,
    });

    await cache.start();

    expect(requestCounts["/main.mp4"]).toBeUndefined();
    expect(requestCounts["/poster.jpg"]).toBeUndefined();

    const item = await cache.getItem("nature", "forest");
    expect(item?.assets[0]?.url).toBe(`${baseUrl}/main.mp4`);
    expect((await cache.getStatus()).lastRun?.stats).toEqual({
      totalAssets: 4,
      downloadedAssets: 0,
      skippedAssets: 4,
      bytesDownloaded: 0,
    });

    manifests = recordManifest({
      snapshotId: "passthrough-v2",
      namespaces: [
        {
          key: "nature",
          items: [
            {
              id: "forest",
              version: "v2",
              kind: "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  fileName: "main.mp4",
                  source: {
                    url: `${baseUrl}/main.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    await cache.syncNow();

    expect(requestCounts["/main.mp4"]).toBeUndefined();
    expect((await cache.getItem("nature", "forest"))?.version).toBe("v2");
    expect((await cache.getItem("nature", "forest"))?.assets[0]?.url).toBe(`${baseUrl}/main.mp4`);
  });

  it("fails fast in passthrough mode when manifest resolution fails", async () => {
    const storageRoot = createStorageRoot();
    const offlineCache = createMediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await offlineCache.start();
    const committedBlobPath = join(
      storageRoot,
      blobPathFor("nature", "forest", "main", "v1", "main.mp4"),
    );
    expect(existsSync(committedBlobPath)).toBe(true);

    const passthroughCache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      resolveManifest: () => {
        throw new Error("manifest unavailable");
      },
    });

    await expect(passthroughCache.start()).rejects.toThrow("manifest unavailable");
    expect((await passthroughCache.getStatus()).activeGenerationId).toBeNull();
    expect(existsSync(committedBlobPath)).toBe(false);
  });

  it("skips unchanged downloads and redownloads when the version changes", async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await cache.start();
    expect(requestCounts["/main.mp4"]).toBe(1);

    await cache.syncNow();
    expect(requestCounts["/main.mp4"]).toBe(1);

    manifests = recordManifest({
      snapshotId: "v2",
      namespaces: [
        {
          key: "nature",
          items: [
            {
              id: "forest",
              version: "v2",
              kind: "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  fileName: "main.mp4",
                  byteLength: 9,
                  source: {
                    url: `${baseUrl}/main.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    await cache.syncNow();
    expect(requestCounts["/main.mp4"]).toBe(2);
  });

  it("supports pipe characters in namespace, item, and asset ids", async () => {
    const storageRoot = createStorageRoot();
    manifests = recordManifest({
      snapshotId: "pipe-ids",
      namespaces: [
        {
          key: "nature|archive",
          items: [
            {
              id: "forest|loop",
              version: "v1",
              kind: "video",
              assets: [
                {
                  id: "main|primary",
                  role: "primary",
                  kind: "video",
                  fileName: "main.mp4",
                  byteLength: 9,
                  source: {
                    url: `${baseUrl}/main.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await cache.start();
    const item = await cache.getItem("nature|archive", "forest|loop");
    expect(item?.assets[0]?.url).toBe(
      "media://asset/nature%7Carchive/forest%7Cloop/main%7Cprimary",
    );

    const matches = await cache.findByFileStem("main", { limit: 10 });
    expect(matches.items).toHaveLength(1);
    expect(matches.items[0]?.item.namespace).toBe("nature|archive");
    expect(matches.items[0]?.item.id).toBe("forest|loop");
    expect(matches.items[0]?.matchedAssetIds).toEqual(["main|primary"]);
  });

  it("marks removed assets for deletion instead of deleting them immediately", async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();
    const initialBlobRoot = join(storageRoot, "blobs");
    const filesBefore = collectFiles(initialBlobRoot);
    expect(filesBefore.length).toBeGreaterThan(0);

    manifests = recordManifest({
      snapshotId: "empty",
      namespaces: [],
    });

    await cache.syncNow();
    const filesAfter = collectFiles(initialBlobRoot);
    expect(filesAfter).toEqual(filesBefore);
    const item = await cache.getItem("nature", "forest");
    expect(item).toBeNull();
  });

  it("serves the last committed snapshot on sync failure by default", async () => {
    const storageRoot = createStorageRoot();
    const cache = createNoSleepCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    manifests = recordManifest({
      snapshotId: "broken",
      namespaces: [
        {
          key: "nature",
          items: [
            {
              id: "forest",
              version: "v2",
              kind: "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  fileName: "broken.mp4",
                  byteLength: 6,
                  source: {
                    url: `${baseUrl}/broken.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    await expect(cache.syncNow()).resolves.toBeUndefined();
    const item = await cache.getItem("nature", "forest");
    expect(item?.version).toBe("v1");
    const status = await cache.getStatus();
    expect(status.error?.code).toBe("SYNC_FAILURE");
  });

  it("throws on sync failure when configured", async () => {
    const storageRoot = createStorageRoot();
    const cache = createNoSleepCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await cache.start();

    manifests = recordManifest({
      snapshotId: "broken",
      namespaces: [
        {
          key: "nature",
          items: [
            {
              id: "forest",
              version: "v2",
              kind: "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  fileName: "broken.mp4",
                  byteLength: 6,
                  source: {
                    url: `${baseUrl}/broken.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    await expect(cache.syncNow()).rejects.toThrow("Download failed");
    const item = await cache.getItem("nature", "forest");
    expect(item?.version).toBe("v1");
  });

  it("fails before downloading when manifest expiresAt is already in the past", async () => {
    const storageRoot = createStorageRoot();
    const currentNow = Date.parse("2026-04-06T12:30:01.000Z");
    const cache = new MediaCache(
      {
        storageRoot,
        onSyncFailure: "throw",
        resolveManifest: () =>
          recordManifest({
            snapshotId: "expired-before-download",
            expiresAt: "2026-04-06T12:30:00.000Z",
            namespaces: [
              {
                key: "nature",
                items: [
                  {
                    id: "forest",
                    version: "v1",
                    kind: "video",
                    assets: [
                      {
                        id: "main",
                        role: "primary",
                        kind: "video",
                        fileName: "main.mp4",
                        byteLength: 9,
                        source: {
                          url: `${baseUrl}/main.mp4`,
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
      },
      {
        now: () => currentNow,
        sleep: async () => undefined,
      },
    );

    await expect(cache.start()).rejects.toThrow(ManifestExpiredError);
    expect(requestCounts["/main.mp4"] ?? 0).toBe(0);

    const status = await cache.getStatus();
    expect(status.phase).toBe("error");
    expect(status.error?.code).toBe("MANIFEST_EXPIRED");
  });

  it("preserves normal download failure behavior when manifest expiresAt is omitted", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache(
      {
        storageRoot,
        onSyncFailure: "throw",
        resolveManifest: () =>
          recordManifest({
            snapshotId: "broken-without-expiry",
            namespaces: [
              {
                key: "nature",
                items: [
                  {
                    id: "forest",
                    version: "v1",
                    kind: "video",
                    assets: [
                      {
                        id: "main",
                        role: "primary",
                        kind: "video",
                        fileName: "nonretryable.mp4",
                        byteLength: 6,
                        source: {
                          url: `${baseUrl}/nonretryable.mp4`,
                        },
                      },
                    ],
                  },
                ],
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
      resolveManifest: () =>
        recordManifest({
          snapshotId: "retry-once",
          namespaces: [
            {
              key: "nature",
              items: [
                {
                  id: "forest",
                  version: "v1",
                  kind: "video",
                  assets: [
                    {
                      id: "main",
                      role: "primary",
                      kind: "video",
                      fileName: "retry-once.mp4",
                      byteLength: "retry-success".length,
                      source: {
                        url: `${baseUrl}/retry-once.mp4`,
                      },
                    },
                  ],
                },
              ],
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
      resolveManifest: () =>
        recordManifest({
          snapshotId: "nonretryable",
          namespaces: [
            {
              key: "nature",
              items: [
                {
                  id: "forest",
                  version: "v1",
                  kind: "video",
                  assets: [
                    {
                      id: "main",
                      role: "primary",
                      kind: "video",
                      fileName: "nonretryable.mp4",
                      byteLength: 1,
                      source: {
                        url: `${baseUrl}/nonretryable.mp4`,
                      },
                    },
                  ],
                },
              ],
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
      resolveManifest: () => manifests,
    });

    await cache.start();

    const handler = await createProtocolHandler(cache, {
      fetchFile: async (_request, filePath) => new Response(readFileSync(filePath, "utf8")),
    });

    const response = await handler(new Request("media://asset/nature/forest/main"));
    expect(await response.text()).toBe("video-one");

    const missing = await handler(new Request("media://asset/nature/forest/missing"));
    expect(missing.status).toBe(404);
  });

  it("skips media:// protocol registration in passthrough mode", async () => {
    const storageRoot = createStorageRoot();
    const cache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      resolveManifest: () => manifests,
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
          resolveManifest: () => manifests,
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
          resolveManifest: () => manifests,
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
        resolveManifest: () => manifests,
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
          resolveManifest: () => manifests,
        }),
    ).toThrow("MediaCacheOptions.logging.format cannot be set when logging.onLog is provided.");
  });

  it("rejects removed flat logging options at the type level", () => {
    const options: TestMediaCacheOptions = {
      storageRoot: createStorageRoot(),
      resolveManifest: () => manifests,
    };
    expect(options.resolveManifest).toBeTypeOf("function");
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
      resolveManifest: () => manifests,
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
        resolveManifest: () => manifests,
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

  it("accepts assetBaseUrl null and uses manifest URLs as-is in passthrough mode", async () => {
    const storageRoot = createStorageRoot();
    const cache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      assetBaseUrl: null,
      resolveManifest: () => manifests,
    });

    await cache.start();

    const item = await cache.getItem("nature", "forest");
    expect(item?.assets[0]?.url).toBe(`${baseUrl}/main.mp4`);
  });

  it("serves byte ranges for committed video assets", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();
    const handler = await createProtocolHandler(cache);

    const response = await handler(
      new Request("media://asset/nature/forest/main", {
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
      resolveManifest: () => manifests,
    });

    await cache.start();
    const handler = await createProtocolHandler(cache);

    const response = await handler(
      new Request("media://asset/nature/forest/main", {
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
      resolveManifest: () => mimeManifest(baseUrl),
    });

    await cache.start();
    const handler = await createProtocolHandler(cache);

    const cases = [
      ["main", "video/mp4"],
      ["webm", "video/webm"],
      ["mov", "video/quicktime"],
      ["jpg", "image/jpeg"],
      ["jpeg", "image/jpeg"],
      ["png", "image/png"],
      ["gif", "image/gif"],
      ["webp", "image/webp"],
      ["vtt", "text/vtt"],
      ["srt", "application/x-subrip"],
      ["mp3", "audio/mpeg"],
      ["wav", "audio/wav"],
      ["html", "text/html; charset=utf-8"],
      ["txt", "text/plain; charset=utf-8"],
      ["json", "application/json; charset=utf-8"],
      ["pdf", "application/pdf"],
    ] as const;

    for (const [assetId, expectedMime] of cases) {
      const response = await handler(new Request(`media://asset/mime/types/${assetId}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(expectedMime);
    }
  });

  it("handles range edge cases for committed assets", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();
    const handler = await createProtocolHandler(cache);

    const cases = [
      {
        name: "full response without range",
        request: new Request("media://asset/nature/forest/main"),
        expectedStatus: 200,
        expectedBody: "video-one",
        expectedContentRange: null,
      },
      {
        name: "bounded range",
        request: new Request("media://asset/nature/forest/main", {
          headers: { range: "bytes=0-4" },
        }),
        expectedStatus: 206,
        expectedBody: "video",
        expectedContentRange: "bytes 0-4/9",
      },
      {
        name: "open ended range",
        request: new Request("media://asset/nature/forest/main", {
          headers: { range: "bytes=5-" },
        }),
        expectedStatus: 206,
        expectedBody: "-one",
        expectedContentRange: "bytes 5-8/9",
      },
      {
        name: "suffix range",
        request: new Request("media://asset/nature/forest/main", {
          headers: { range: "bytes=-5" },
        }),
        expectedStatus: 206,
        expectedBody: "o-one",
        expectedContentRange: "bytes 4-8/9",
      },
      {
        name: "invalid range",
        request: new Request("media://asset/nature/forest/main", {
          headers: { range: "bytes=99-100" },
        }),
        expectedStatus: 416,
        expectedBody: "",
        expectedContentRange: "bytes */9",
      },
      {
        name: "unsupported multi-range",
        request: new Request("media://asset/nature/forest/main", {
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
      resolveManifest: () => manifests,
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

  it("requires storagePath configuration", async () => {
    const cache = new MediaCache({
      resolveManifest: () =>
        recordManifest({
          snapshotId: "missing-storage-path",
          namespaces: [],
        }),
    });

    await expect(cache.start()).rejects.toThrow(DataValidationError);
  });

  it("ignores invalid stored status snapshots and logs a warning", async () => {
    const storageRoot = createStorageRoot();
    const initialCache = new MediaCache({
      storageRoot,
      resolveManifest: () => manifests,
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
      resolveManifest: () => manifests,
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
      resolveManifest: () => manifests,
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

  it.each([
    {
      name: "item blobs",
      table: "items",
      column: "blobs_json",
      value: '{"hero":1}',
      assetId: null,
    },
    {
      name: "item metadata",
      table: "items",
      column: "metadata_json",
      value: "{",
      assetId: null,
    },
    {
      name: "asset metadata",
      table: "assets",
      column: "metadata_json",
      value: "{",
      assetId: "main",
    },
  ])("throws DataValidationError for malformed committed $name JSON", async (testCase) => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      resolveManifest: () => manifests,
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

    if (testCase.table === "items") {
      db.db
        .prepare(
          `UPDATE items
           SET ${testCase.column} = ?
           WHERE generation_id = ? AND namespace_key = ? AND item_id = ?`,
        )
        .run(testCase.value, activeGenerationId, "nature", "forest");
    } else {
      db.db
        .prepare(
          `UPDATE assets
           SET ${testCase.column} = ?
           WHERE generation_id = ? AND namespace_key = ? AND item_id = ? AND asset_id = ?`,
        )
        .run(testCase.value, activeGenerationId, "nature", "forest", testCase.assetId);
    }

    await expect(cache.getItem("nature", "forest")).rejects.toThrow(DataValidationError);
  });

  it("rejects invalid cursor payloads before querying the database", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    const invalidBase64Cursor = "!not-base64!";
    const invalidDecodedCursor = Buffer.from(JSON.stringify({ index: -1 }), "utf8").toString(
      "base64url",
    );

    await expect(
      cache.listNamespace("nature", {
        cursor: invalidBase64Cursor,
      }),
    ).rejects.toThrow(DataValidationError);
    await expect(
      cache.listNamespace("nature", {
        cursor: invalidDecodedCursor,
      }),
    ).rejects.toThrow(DataValidationError);
    const emptyCache = createMediaCache({
      storageRoot: createStorageRoot(),
      resolveManifest: () => manifests,
    });
    await expect(
      emptyCache.findByFileStem("main", {
        cursor: invalidDecodedCursor,
      }),
    ).rejects.toThrow(DataValidationError);
    await expect(
      cache.listNamespace("nature", null as unknown as { limit?: number; cursor?: string }),
    ).resolves.toMatchObject({
      items: expect.any(Array),
    });
    await expect(
      cache.findByFileStem(
        "main",
        null as unknown as { limit?: number; cursor?: string; namespace?: string },
      ),
    ).resolves.toMatchObject({
      items: expect.any(Array),
    });
    await expect(cache.listNamespaceTree("nature", { limit: 0 })).resolves.toMatchObject({
      items: expect.any(Array),
      nextCursor: expect.any(String),
    });

    const handlers = await createIpcHandlers(cache);
    const db = (
      cache as unknown as {
        db: {
          listNamespace(namespace: string, pagination?: unknown): unknown;
        };
      }
    ).db;
    const originalListNamespace = db.listNamespace.bind(db);
    let dbCalled = false;
    db.listNamespace = (namespace: string, pagination?: unknown) => {
      dbCalled = true;
      return originalListNamespace(namespace, pagination);
    };

    await expect(
      handlers.get(MEDIA_CACHE_IPC.listNamespace)!("nature", { limit: "10" } as unknown as {
        limit: number;
      }),
    ).rejects.toThrow(DataValidationError);
    await expect(
      handlers.get(MEDIA_CACHE_IPC.listNamespace)!("nature", { limit: -5 }),
    ).rejects.toThrow(DataValidationError);
    expect(dbCalled).toBe(false);
    await expect(
      handlers.get(MEDIA_CACHE_IPC.listNamespaceTree)!("nature", {
        limit: 0,
      } as unknown as { limit?: number }),
    ).resolves.toMatchObject({
      items: expect.any(Array),
      nextCursor: expect.any(String),
    });
    expect(dbCalled).toBe(false);
    await expect(
      handlers.get(MEDIA_CACHE_IPC.listNamespace)!("nature", {
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
      resolveManifest: () => manifests,
    });
    const syncSpy = vi.spyOn(cache, "syncNow").mockResolvedValue(undefined);
    const handlers = await createIpcHandlers(cache);

    await expect(handlers.get(MEDIA_CACHE_IPC.syncNow)!()).resolves.toBeUndefined();
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects empty string and oversized identifiers with DataValidationError", async () => {
    const cache = createMediaCache({
      storageRoot: createStorageRoot(),
      resolveManifest: () => manifests,
    });
    await cache.start();

    await expect(cache.getItem("", "forest")).rejects.toThrow(DataValidationError);
    await expect(cache.getItem("nature", "")).rejects.toThrow(DataValidationError);
    await expect(cache.listNamespace("")).rejects.toThrow(DataValidationError);
    await expect(cache.listNamespaceTree("")).rejects.toThrow(DataValidationError);
    await expect(cache.findByFileStem("")).rejects.toThrow(DataValidationError);

    const long = "x".repeat(2001);
    await expect(cache.getItem(long, "forest")).rejects.toThrow(DataValidationError);
    await expect(cache.getItem("nature", long)).rejects.toThrow(DataValidationError);
    await expect(cache.listNamespace(long)).rejects.toThrow(DataValidationError);
    await expect(cache.listNamespaceTree(long)).rejects.toThrow(DataValidationError);
    await expect(cache.findByFileStem(long)).rejects.toThrow(DataValidationError);
  });

  it("wraps circular manifest metadata serialization errors in DataValidationError", async () => {
    const storageRoot = createStorageRoot();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    manifests = recordManifest({
      snapshotId: "circular-metadata",
      namespaces: [
        {
          key: "nature",
          metadata: circular as unknown as Record<string, JsonValue>,
          items: [],
        },
      ],
    });

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await expect(cache.start()).rejects.toThrow(DataValidationError);
  });

  it("accepts non-integer manifest byteLength values", async () => {
    const storageRoot = createStorageRoot();
    manifests = recordManifest({
      snapshotId: "fractional-byte-length",
      namespaces: [
        {
          key: "nature",
          items: [
            {
              id: "forest",
              version: "v1",
              kind: "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  byteLength: 12.5,
                  source: { url: `${baseUrl}/main.mp4` },
                },
              ],
            },
          ],
        },
      ],
    });

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await cache.start();
    const item = await cache.getItem("nature", "forest");
    expect(item?.assets[0]?.byteLength).toBe(12.5);
  });

  it("rejects invalid persisted item kinds", async () => {
    const storageRoot = createStorageRoot();
    manifests = recordManifest({
      snapshotId: "invalid-item-kind",
      namespaces: [
        {
          key: "nature",
          items: [
            {
              id: "forest",
              version: "v1",
              kind: "legacy-video" as unknown as "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  source: { url: `${baseUrl}/main.mp4` },
                },
              ],
            },
          ],
        },
      ],
    });

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await expect(cache.start()).rejects.toThrow(DataValidationError);
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
          devPassthrough: false,
          resolveManifest: async () => recordManifest({ namespaces: [] }),
        });
        new RawMediaCache({
          devPassthrough: false,
          resolveManifest: async () => recordManifest({ namespaces: [] }),
        });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
        // Keep the registration flag true after this assertion. Resetting to false can
        // re-trigger the real Electron registration path in later tests.
      }
    },
  );
});
