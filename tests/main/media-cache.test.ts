import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  copyFileSync,
  mkdtempSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  MediaCache as RawMediaCache,
  createMediaCache as createRawMediaCache,
  resetMediaCacheProtocolRegistrationStateForTests,
  type MediaCacheMain,
} from "../../src/main/media-cache.js";
import { defineManifest, defineManifestAsset, defineManifestItem } from "../../src/main/index.js";
import { normalizeManifest } from "../../src/shared/normalize.js";
import {
  DataValidationError,
  ManifestValidationError,
  StorageLimitError,
} from "../../src/shared/errors.js";
import { MEDIA_CACHE_IPC } from "../../src/shared/ipc.js";
import type {
  ManifestInput,
  MediaAssetDefinition,
  MediaCacheLogEvent,
  JsonValue,
} from "../../src/shared/types.js";

class MediaCache extends RawMediaCache {
  constructor(
    options: ConstructorParameters<typeof RawMediaCache>[0],
    deps?: ConstructorParameters<typeof RawMediaCache>[1],
  ) {
    super({ devPassthrough: false, ...options }, deps);
  }
}

function createMediaCache(options: Parameters<typeof createRawMediaCache>[0]) {
  return createRawMediaCache({ devPassthrough: false, ...options });
}

const electronSupportsProtocolRegistration = (() => {
  try {
    const req = createRequire(import.meta.url);
    const electron = req("electron") as typeof import("electron");
    return typeof electron.protocol?.registerSchemesAsPrivileged === "function";
  } catch {
    return false;
  }
})();

describe("manifest normalization", () => {
  it("normalizes flat arrays into the default namespace", () => {
    const manifest = normalizeManifest([
      {
        id: "item-1",
        version: "v1",
        kind: "video",
        assets: [
          {
            id: "main",
            role: "primary",
            kind: "video",
            source: {
              url: "https://example.com/file.mp4",
            },
          },
        ],
      },
    ]);

    expect(manifest.namespaces).toHaveLength(1);
    expect(manifest.namespaces[0]?.key).toBe("default");
    expect(manifest.namespaces[0]?.items[0]?.assets[0]?.normalizedFileName).toBe("file.mp4");
  });

  it("prefers explicit fileName over URL-derived defaults", () => {
    const manifest = normalizeManifest([
      {
        id: "item-1",
        version: "v1",
        kind: "video",
        assets: [
          {
            id: "main",
            role: "primary",
            kind: "video",
            fileName: "custom-name.mp4",
            source: {
              url: "https://example.com/file.mp4",
            },
          },
        ],
      },
    ]);

    expect(manifest.namespaces[0]?.items[0]?.assets[0]?.normalizedFileName).toBe("custom-name.mp4");
  });

  it("rejects duplicate namespace keys, item ids, and asset ids", () => {
    expect(() =>
      normalizeManifest({
        namespaces: [
          {
            key: "dup",
            items: [],
          },
          {
            key: "dup",
            items: [],
          },
        ],
      }),
    ).toThrow(ManifestValidationError);

    expect(() =>
      normalizeManifest({
        namespaces: [
          {
            key: "gallery",
            items: [
              {
                id: "same",
                version: "v1",
                kind: "image",
                assets: [],
              },
              {
                id: "same",
                version: "v1",
                kind: "image",
                assets: [],
              },
            ],
          },
        ],
      }),
    ).toThrow(ManifestValidationError);

    expect(() =>
      normalizeManifest({
        namespaces: [
          {
            key: "gallery",
            items: [
              {
                id: "item",
                version: "v1",
                kind: "image",
                assets: [
                  {
                    id: "dup",
                    role: "primary",
                    kind: "image",
                    source: { url: "https://example.com/a.jpg" },
                  },
                  {
                    id: "dup",
                    role: "thumbnail",
                    kind: "thumbnail",
                    source: { url: "https://example.com/b.jpg" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(ManifestValidationError);
  });
});

describe("producer manifest helpers", () => {
  it("validates and returns manifest assets and items", () => {
    const asset = defineManifestAsset({
      id: "main",
      role: "primary",
      kind: "video",
      source: {
        url: "https://cdn.example.com/forest.mp4",
      },
    });
    const item = defineManifestItem({
      id: "forest",
      version: "v1",
      kind: "video",
      assets: [asset],
    });
    const manifest = defineManifest({
      namespaces: [
        {
          key: "nature",
          items: [item],
        },
      ],
    });

    expect(manifest.namespaces[0]?.items[0]?.id).toBe("forest");
    expect(manifest.namespaces[0]?.items[0]?.assets[0]?.id).toBe("main");
  });

  it("derives fileName by default and keeps explicit overrides", () => {
    const derivedAsset = defineManifestAsset({
      id: "main",
      role: "primary",
      kind: "video",
      source: {
        url: "https://cdn.example.com/videos/forest.mp4",
      },
    });
    expect(derivedAsset.fileName).toBe("forest.mp4");

    const explicitAsset = defineManifestAsset({
      id: "main",
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
      defineManifestAsset({
        id: "",
        role: "primary",
        kind: "video",
        source: {
          url: "not-a-url",
        },
      }),
    ).toThrow(DataValidationError);
  });

  it("throws ManifestValidationError when semantic manifest checks fail", () => {
    expect(() =>
      defineManifest({
        namespaces: [
          {
            key: "dup",
            items: [],
          },
          {
            key: "dup",
            items: [],
          },
        ],
      }),
    ).toThrow(ManifestValidationError);
  });
});

describe("media cache sync and queries", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl = "";
  let requestCounts: Record<string, number>;
  let requestMethods: Record<string, string[]>;
  let requestRanges: Record<string, string[]>;
  let requestAuthHeaders: Record<string, string[]>;
  let manifests: ManifestInput;

  beforeAll(async () => {
    requestCounts = {};
    requestMethods = {};
    requestRanges = {};
    requestAuthHeaders = {};
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url ?? "/";
      requestCounts[path] = (requestCounts[path] ?? 0) + 1;
      requestMethods[path] ??= [];
      requestMethods[path].push(req.method ?? "GET");
      requestRanges[path] ??= [];
      requestRanges[path].push(req.headers.range ?? "");
      requestAuthHeaders[path] ??= [];
      requestAuthHeaders[path].push(
        Array.isArray(req.headers["x-media-auth"])
          ? req.headers["x-media-auth"].join(",")
          : (req.headers["x-media-auth"] ?? ""),
      );

      if (path === "/broken.mp4") {
        res.writeHead(500);
        res.end("broken");
        return;
      }

      if (path === "/retry-once.mp4") {
        if (requestCounts[path] === 1) {
          res.writeHead(503);
          res.end("retry");
          return;
        }
        sendStaticBody(req, res, "retry-success", "video/mp4");
        return;
      }

      if (path === "/nonretryable.mp4") {
        res.writeHead(404);
        res.end("missing");
        return;
      }

      if (path === "/range-ignored.mp4") {
        sendStaticBody(req, res, "range-ignore", "video/mp4", { ignoreRange: true });
        return;
      }

      if (path === "/range-mismatch.mp4") {
        sendStaticBody(req, res, "range-mismatch", "video/mp4", { forceRangeStart: 0 });
        return;
      }

      if (path === "/range-not-satisfiable.mp4") {
        if (req.headers.range) {
          res.writeHead(416, {
            "Content-Range": `bytes */${"range-416".length}`,
          });
          res.end();
          return;
        }
        sendStaticBody(req, res, "range-416", "video/mp4");
        return;
      }

      if (path === "/resumable.mp4") {
        sendStaticBody(req, res, "resume-data", "video/mp4");
        return;
      }

      if (path === "/resume-retryable.mp4") {
        if (req.headers.range && requestCounts[path] === 1) {
          res.writeHead(503);
          res.end("retry");
          return;
        }
        sendStaticBody(req, res, "resume-retry-success", "video/mp4");
        return;
      }

      if (path === "/drop-after-two.mp4") {
        sendInterruptedBody(req, res, "retry-bytes", "video/mp4", 2);
        return;
      }

      if (path === "/mime-fallback.bin") {
        sendStaticBody(req, res, "mime-fallback", "video/quicktime");
        return;
      }

      if (path === "/mime-manifest.bin") {
        sendStaticBody(req, res, "mime-manifest", "application/octet-stream");
        return;
      }

      if (path === "/auth.mp4") {
        if (req.headers["x-media-auth"] !== "passthrough-secret") {
          res.writeHead(401);
          res.end("unauthorized");
          return;
        }
        sendStaticBody(req, res, "auth-video", "video/mp4");
        return;
      }

      if (path === "/method-bound.mp4") {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end("method-not-allowed");
          return;
        }
        sendStaticBody(req, res, "method-video", "video/mp4");
        return;
      }

      const payloads: Record<string, string> = {
        "/main.mp4": "video-one",
        "/poster.jpg": "poster",
        "/flower.mp4": "flower-video",
        "/sub.vtt": "WEBVTT",
      };
      const body = payloads[path];
      if (!body) {
        res.writeHead(404);
        res.end("missing");
        return;
      }

      res.writeHead(200, {
        "Content-Type": path.endsWith(".jpg")
          ? "image/jpeg"
          : path.endsWith(".vtt")
            ? "text/vtt"
            : "video/mp4",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    requestCounts = {};
    requestMethods = {};
    requestRanges = {};
    requestAuthHeaders = {};
    manifests = {
      snapshotId: "initial",
      namespaces: [
        {
          key: "nature",
          items: [
            {
              id: "forest",
              version: "v1",
              kind: "video",
              title: "Forest",
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
                {
                  id: "poster",
                  role: "poster",
                  kind: "poster",
                  fileName: "poster.jpg",
                  byteLength: 6,
                  source: {
                    url: `${baseUrl}/poster.jpg`,
                  },
                },
              ],
            },
          ],
        },
        {
          key: "nature.flowerVideos",
          items: [
            {
              id: "rose",
              version: "v1",
              kind: "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  fileName: "flower.mp4",
                  byteLength: 12,
                  source: {
                    url: `${baseUrl}/flower.mp4`,
                  },
                },
                {
                  id: "captions",
                  role: "subtitle",
                  kind: "subtitle",
                  fileName: "sub.vtt",
                  byteLength: 6,
                  source: {
                    url: `${baseUrl}/sub.vtt`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
  });

  function createStorageRoot(): string {
    return mkdtempSync(join(tmpdir(), "media-cache-test-"));
  }

  function createNoSleepCache(options: ConstructorParameters<typeof MediaCache>[0]) {
    return new MediaCache(options, {
      sleep: async () => undefined,
    });
  }

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

  it("disables passthrough by default when devPassthrough is not set", async () => {
    requestCounts = {};
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
      requestCounts = {};
      const logs: MediaCacheLogEvent[] = [];
      const cache = new RawMediaCache({
        storageRoot: createStorageRoot(),
        onSyncFailure: "throw",
        onLog: (e) => {
          logs.push(e);
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
      onLog: (e) => {
        passthroughLogs.push(e);
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

    requestCounts = {};
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

    manifests = {
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
    };

    await cache.syncNow();

    expect(requestCounts["/main.mp4"]).toBeUndefined();
    expect((await cache.getItem("nature", "forest"))?.version).toBe("v2");
    expect((await cache.getItem("nature", "forest"))?.assets[0]?.url).toBe(`${baseUrl}/main.mp4`);
  });

  it("uses assetBaseUrl as an origin override in passthrough mode", async () => {
    const storageRoot = createStorageRoot();
    const manifestWithQuerySource: ManifestInput = {
      snapshotId: "asset-base-url",
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
                  source: {
                    url: `${baseUrl}/main.mp4?token=abc123`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const passthroughCache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      assetBaseUrl: "https://assets.example.test",
      resolveManifest: () => manifestWithQuerySource,
    });

    await passthroughCache.start();

    const item = await passthroughCache.getItem("nature", "forest");
    expect(item?.assets[0]?.url).toBe("https://assets.example.test/main.mp4?token=abc123");
  });

  it("emits resolve_asset_base_url_fallback and returns source URL when asset URL cannot be parsed in passthrough mode", async () => {
    const storageRoot = createStorageRoot();
    const logs: MediaCacheLogEvent[] = [];
    const invalidUrlManifest: ManifestInput = {
      snapshotId: "invalid-url-fallback",
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
                  fileName: "video.mp4",
                  source: {
                    url: "not-a-valid-url",
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      assetBaseUrl: "https://assets.example.test",
      logLevel: "debug",
      onLog: (entry) => {
        logs.push(entry);
      },
      resolveManifest: () => invalidUrlManifest,
    });

    await cache.start();
    const item = await cache.getItem("nature", "forest");

    expect(item?.assets[0]?.url).toBe("not-a-valid-url");
    expect(logs.some((e) => e.event === "resolve_asset_base_url_fallback")).toBe(true);
  });

  it("does not call resolveAssetRequest in passthrough mode", async () => {
    const storageRoot = createStorageRoot();
    let resolveCalls = 0;
    const cache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      resolveManifest: () => manifests,
      resolveAssetRequest: () => {
        resolveCalls += 1;
        return {
          url: `${baseUrl}/auth.mp4`,
        };
      },
    });

    await cache.start();
    expect(resolveCalls).toBe(0);
    expect((await cache.getItem("nature", "forest"))?.assets[0]?.url).toBe(`${baseUrl}/main.mp4`);
  });

  it("clears prior local state on passthrough startup", async () => {
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
      resolveManifest: () => manifests,
    });

    await passthroughCache.start();

    expect(existsSync(committedBlobPath)).toBe(false);
    expect((await passthroughCache.getStatus()).activeGenerationId).not.toBeNull();
    expect((await passthroughCache.getItem("nature", "forest"))?.assets[0]?.url).toBe(
      `${baseUrl}/main.mp4`,
    );
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

    manifests = {
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
    };

    await cache.syncNow();
    expect(requestCounts["/main.mp4"]).toBe(2);
  });

  it("skips request resolution when an unchanged cached blob can be reused", async () => {
    const storageRoot = createStorageRoot();
    let resolveCalls = 0;
    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
      resolveAssetRequest: ({ asset }) => {
        resolveCalls += 1;
        return asset.source;
      },
    });

    await cache.start();
    expect(resolveCalls).toBe(4);

    await cache.syncNow();
    expect(resolveCalls).toBe(4);
    expect(requestCounts["/main.mp4"]).toBe(1);
  });

  it("reuses cached assets when stored relative paths use windows separators", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();
    expect(requestCounts["/main.mp4"]).toBe(1);

    const db = (
      cache as unknown as {
        db: {
          getActiveGenerationId(): number | null;
          getGenerationAssets(generationId: number): Array<{
            namespace: string;
            itemId: string;
            assetId: string;
            relativePath: string | null;
          }>;
          setAssetRelativePath(
            generationId: number,
            namespace: string,
            itemId: string,
            assetId: string,
            relativePath: string,
          ): void;
        };
      }
    ).db;
    const activeGenerationId = db.getActiveGenerationId();
    expect(activeGenerationId).not.toBeNull();

    const mainAsset = db
      .getGenerationAssets(activeGenerationId!)
      .find(
        (row) => row.namespace === "nature" && row.itemId === "forest" && row.assetId === "main",
      );
    expect(mainAsset?.relativePath).toBeTruthy();

    const originalPath = join(storageRoot, mainAsset!.relativePath!);
    const windowsRelativePath = "blobs\\nature\\forest\\main\\v1\\main.mp4";
    copyFileSync(originalPath, join(storageRoot, windowsRelativePath));
    db.setAssetRelativePath(activeGenerationId!, "nature", "forest", "main", windowsRelativePath);

    await cache.syncNow();
    expect(requestCounts["/main.mp4"]).toBe(1);
  });

  it("supports pipe characters in namespace, item, and asset ids", async () => {
    const storageRoot = createStorageRoot();
    manifests = {
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
    };

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

  it("preserves JSON.stringify semantics for undefined manifest metadata and blobs", async () => {
    const storageRoot = createStorageRoot();
    manifests = {
      snapshotId: "undefined-json-fields",
      namespaces: [
        {
          key: "nature",
          metadata: {
            keep: "value",
            drop: undefined,
          } as unknown as Record<string, JsonValue>,
          items: [
            {
              id: "forest",
              version: "v1",
              kind: "video",
              blobs: {
                hero: "main",
                drop: undefined,
              } as unknown as Record<string, string>,
              metadata: {
                keep: true,
                drop: undefined,
              } as unknown as Record<string, JsonValue>,
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
                  metadata: {
                    keep: "asset",
                    drop: undefined,
                  } as unknown as Record<string, JsonValue>,
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await expect(cache.start()).resolves.toBeUndefined();
    const item = await cache.getItem("nature", "forest");
    expect(item?.blobs).toEqual({ hero: "main" });
    expect(item?.metadata).toEqual({ keep: true });
    expect(item?.assets[0]?.metadata).toEqual({ keep: "asset" });
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

    manifests = {
      snapshotId: "empty",
      namespaces: [],
    };

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

    manifests = {
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
    };

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

    manifests = {
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
    };

    await expect(cache.syncNow()).rejects.toThrow("Download failed");
    const item = await cache.getItem("nature", "forest");
    expect(item?.version).toBe("v1");
  });

  it("resumes an existing partial download across cache instances", async () => {
    const storageRoot = createStorageRoot();
    const partialPath = join(
      storageRoot,
      partialPathFor("nature", "forest", "main", "v1", "resumable.mp4"),
    );
    mkdirSync(join(storageRoot, "temp"), { recursive: true });
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, "resume");

    manifests = {
      snapshotId: "resume",
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
                  fileName: "resumable.mp4",
                  byteLength: "resume-data".length,
                  source: {
                    url: `${baseUrl}/resumable.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = createNoSleepCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    expect(requestRanges["/resumable.mp4"]).toContain("bytes=6-");
    expect(existsSync(partialPath)).toBe(false);

    const finalPath = join(
      storageRoot,
      blobPathFor("nature", "forest", "main", "v1", "resumable.mp4"),
    );
    expect(readFileSync(finalPath, "utf8")).toBe("resume-data");
  });

  it("discounts existing partial bytes when enforcing reserveFreeBytes", async () => {
    const storageRoot = createStorageRoot();
    const body = "x".repeat(1_000_000);
    const partialPath = join(
      storageRoot,
      partialPathFor("nature", "forest", "main", "v1", "reserve-resumable.mp4"),
    );
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, body.slice(0, 990_000));

    manifests = {
      snapshotId: "reserve-resume",
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
                  fileName: "reserve-resumable.mp4",
                  byteLength: body.length,
                  source: {
                    url: `${baseUrl}/reserve-resumable.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = new MediaCache(
      {
        storageRoot,
        resolveManifest: () => manifests,
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
              namespace: string;
              itemId: string;
              assetId: string;
              request: { url: string };
              fileName: string;
              resolvedVersion: string;
              byteLength?: number;
            }>,
          ): Promise<void>;
        }
      ).enforceStorageLimits([
        {
          namespace: "nature",
          itemId: "forest",
          assetId: "main",
          request: { url: `${baseUrl}/reserve-resumable.mp4` },
          fileName: "reserve-resumable.mp4",
          resolvedVersion: "v1",
          byteLength: body.length,
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
      partialPathFor("nature", "forest", "main", "v1", "resume-retryable.mp4"),
    );
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, "resume");

    manifests = {
      snapshotId: "resume-retryable",
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
                  fileName: "resume-retryable.mp4",
                  byteLength: "resume-retry-success".length,
                  source: {
                    url: `${baseUrl}/resume-retryable.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = createNoSleepCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    expect(requestRanges["/resume-retryable.mp4"]).toEqual(["bytes=6-", "bytes=6-"]);
    expect(existsSync(partialPath)).toBe(false);

    const finalPath = join(
      storageRoot,
      blobPathFor("nature", "forest", "main", "v1", "resume-retryable.mp4"),
    );
    expect(readFileSync(finalPath, "utf8")).toBe("resume-retry-success");
  });

  it("restarts from byte zero when a server ignores a range request", async () => {
    const storageRoot = createStorageRoot();
    const partialPath = join(
      storageRoot,
      partialPathFor("nature", "forest", "main", "v1", "range-ignored.mp4"),
    );
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, "range");

    manifests = {
      snapshotId: "range-ignored",
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
                  fileName: "range-ignored.mp4",
                  byteLength: "range-ignore".length,
                  source: {
                    url: `${baseUrl}/range-ignored.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = createNoSleepCache({
      storageRoot,
      resolveManifest: () => manifests,
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
      partialPathFor("nature", "forest", "main", "v1", "range-mismatch.mp4"),
    );
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, "range");

    manifests = {
      snapshotId: "range-mismatch",
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
                  fileName: "range-mismatch.mp4",
                  byteLength: "range-mismatch".length,
                  source: {
                    url: `${baseUrl}/range-mismatch.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = createNoSleepCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    expect(requestCounts["/range-mismatch.mp4"]).toBe(2);
    expect(requestRanges["/range-mismatch.mp4"]).toEqual(["bytes=5-", ""]);
    expect(existsSync(partialPath)).toBe(false);

    const finalPath = join(
      storageRoot,
      blobPathFor("nature", "forest", "main", "v1", "range-mismatch.mp4"),
    );
    expect(readFileSync(finalPath, "utf8")).toBe("range-mismatch");
  });

  it("restarts from byte zero when a server rejects a completed range with 416", async () => {
    const storageRoot = createStorageRoot();
    const body = "range-416";
    const partialPath = join(
      storageRoot,
      partialPathFor("nature", "forest", "main", "v1", "range-not-satisfiable.mp4"),
    );
    mkdirSync(join(partialPath, ".."), { recursive: true });
    writeFileSync(partialPath, body);

    manifests = {
      snapshotId: "range-not-satisfiable",
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
                  fileName: "range-not-satisfiable.mp4",
                  byteLength: body.length,
                  source: {
                    url: `${baseUrl}/range-not-satisfiable.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = createNoSleepCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    expect(requestCounts["/range-not-satisfiable.mp4"]).toBe(2);
    expect(requestRanges["/range-not-satisfiable.mp4"]).toEqual([`bytes=${body.length}-`, ""]);
    expect(existsSync(partialPath)).toBe(false);

    const finalPath = join(
      storageRoot,
      blobPathFor("nature", "forest", "main", "v1", "range-not-satisfiable.mp4"),
    );
    expect(readFileSync(finalPath, "utf8")).toBe(body);
  });

  it("retries retryable HTTP failures and does not retry non-retryable 4xx failures", async () => {
    const retryableRoot = createStorageRoot();
    const retryableCache = createNoSleepCache({
      storageRoot: retryableRoot,
      resolveManifest: () => ({
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
      resolveManifest: () => ({
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

  it("preserves partial files after exhausting retryable download failures", async () => {
    const storageRoot = createStorageRoot();
    manifests = {
      snapshotId: "drop-after-two",
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
                  fileName: "drop-after-two.mp4",
                  byteLength: "retry-bytes".length,
                  source: {
                    url: `${baseUrl}/drop-after-two.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = createNoSleepCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await expect(cache.start()).rejects.toThrow("terminated");
    const partialPath = join(
      storageRoot,
      partialPathFor("nature", "forest", "main", "v1", "drop-after-two.mp4"),
    );
    expect(existsSync(partialPath)).toBe(true);
    expect(statSync(partialPath).size).toBeGreaterThan(0);
    expect(
      existsSync(
        join(storageRoot, blobPathFor("nature", "forest", "main", "v1", "drop-after-two.mp4")),
      ),
    ).toBe(false);
  });

  it("cleans up obsolete partial files that no longer match current download targets", async () => {
    const storageRoot = createStorageRoot();
    const obsoletePartialPath = join(
      storageRoot,
      partialPathFor("nature", "forest", "main", "stale-version", "main.mp4"),
    );
    mkdirSync(join(obsoletePartialPath, ".."), { recursive: true });
    writeFileSync(obsoletePartialPath, "stale-bytes");

    const cache = createNoSleepCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    expect(existsSync(obsoletePartialPath)).toBe(false);
    expect(
      existsSync(join(storageRoot, blobPathFor("nature", "forest", "main", "v1", "main.mp4"))),
    ).toBe(true);
  });

  it("cleans up obsolete partial files while passthrough mode is enabled", async () => {
    const storageRoot = createStorageRoot();
    const obsoletePartialPath = join(
      storageRoot,
      partialPathFor("nature", "forest", "main", "stale-version", "main.mp4"),
    );
    mkdirSync(join(obsoletePartialPath, ".."), { recursive: true });
    writeFileSync(obsoletePartialPath, "stale-bytes");

    const cache = new RawMediaCache({
      storageRoot,
      devPassthrough: true,
      resolveManifest: () => manifests,
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
        resolveManifest: () => manifests,
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
              headers: {
                "Content-Type": "video/mp4",
              },
            },
          ),
      },
    );

    await expect(cache.start()).rejects.toThrow(StorageLimitError);
    const partialPath = join(
      storageRoot,
      partialPathFor("nature", "forest", "main", "v1", "main.mp4"),
    );
    expect(existsSync(partialPath)).toBe(false);
  });

  it("cleans up newly staged blob files after a failed sync while keeping the last committed snapshot", async () => {
    const storageRoot = createStorageRoot();
    const cache = createNoSleepCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    manifests = {
      snapshotId: "cleanup-failed-stage",
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
                  fileName: "retry-once.mp4",
                  byteLength: "retry-success".length,
                  source: {
                    url: `${baseUrl}/retry-once.mp4`,
                  },
                },
                {
                  id: "poster",
                  role: "poster",
                  kind: "poster",
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
    };

    await cache.syncNow();

    expect(
      existsSync(
        join(storageRoot, blobPathFor("nature", "forest", "main", "v2", "retry-once.mp4")),
      ),
    ).toBe(false);
    expect(
      existsSync(join(storageRoot, blobPathFor("nature", "forest", "main", "v1", "main.mp4"))),
    ).toBe(true);
    expect((await cache.getItem("nature", "forest"))?.version).toBe("v1");
  });

  it("prunes expired deletions before enforcing storage limits", async () => {
    let currentNow = 1_000;
    const storageRoot = createStorageRoot();
    manifests = {
      snapshotId: "small-initial",
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
    };
    const cache = new MediaCache(
      {
        storageRoot,
        maxCacheBytes: 15,
        staleDeleteAfterMs: 10,
        resolveManifest: () => manifests,
      },
      {
        now: () => currentNow,
        sleep: async () => undefined,
      },
    );

    await cache.start();

    manifests = {
      snapshotId: "pending-delete",
      namespaces: [],
    };
    await cache.syncNow();

    currentNow = 2_000;
    manifests = {
      snapshotId: "after-prune",
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
                  fileName: "flower.mp4",
                  byteLength: 12,
                  source: {
                    url: `${baseUrl}/flower.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    await expect(cache.syncNow()).resolves.toBeUndefined();
    expect(
      existsSync(join(storageRoot, blobPathFor("nature", "forest", "main", "v1", "main.mp4"))),
    ).toBe(false);
    expect(
      existsSync(join(storageRoot, blobPathFor("nature", "forest", "main", "v2", "flower.mp4"))),
    ).toBe(true);
  });

  it("retains multiple obsolete blob versions until each expires", async () => {
    let currentNow = 1_000;
    const storageRoot = createStorageRoot();
    manifests = {
      snapshotId: "retain-v1",
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
                  byteLength: "video-one".length,
                  source: {
                    url: `${baseUrl}/main.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = new MediaCache(
      {
        storageRoot,
        staleDeleteAfterMs: 1_000,
        resolveManifest: () => manifests,
      },
      {
        now: () => currentNow,
        sleep: async () => undefined,
      },
    );

    await cache.start();

    currentNow = 1_100;
    manifests = {
      snapshotId: "retain-v2",
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
                  fileName: "flower.mp4",
                  byteLength: "flower-video".length,
                  source: {
                    url: `${baseUrl}/flower.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    await cache.syncNow();

    currentNow = 1_200;
    manifests = {
      snapshotId: "retain-v3",
      namespaces: [
        {
          key: "nature",
          items: [
            {
              id: "forest",
              version: "v3",
              kind: "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  fileName: "resumable.mp4",
                  byteLength: "resume-data".length,
                  source: {
                    url: `${baseUrl}/resumable.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    await cache.syncNow();

    const v1Path = join(storageRoot, blobPathFor("nature", "forest", "main", "v1", "main.mp4"));
    const v2Path = join(storageRoot, blobPathFor("nature", "forest", "main", "v2", "flower.mp4"));
    const v3Path = join(
      storageRoot,
      blobPathFor("nature", "forest", "main", "v3", "resumable.mp4"),
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

  it("uses response content type only as a mimeType fallback", async () => {
    const storageRoot = createStorageRoot();
    manifests = {
      snapshotId: "mime-fallback",
      namespaces: [
        {
          key: "nature",
          items: [
            {
              id: "fallback",
              version: "v1",
              kind: "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  fileName: "mime-fallback.bin",
                  byteLength: "mime-fallback".length,
                  source: {
                    url: `${baseUrl}/mime-fallback.bin`,
                  },
                },
              ],
            },
            {
              id: "manifest",
              version: "v1",
              kind: "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  mimeType: "video/mp4",
                  fileName: "mime-manifest.bin",
                  byteLength: "mime-manifest".length,
                  source: {
                    url: `${baseUrl}/mime-manifest.bin`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = createNoSleepCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    const fallbackItem = await cache.getItem("nature", "fallback");
    expect(fallbackItem?.assets[0]?.mimeType).toBe("video/quicktime");

    const manifestItem = await cache.getItem("nature", "manifest");
    expect(manifestItem?.assets[0]?.mimeType).toBe("video/mp4");

    manifests = {
      snapshotId: "mime-fallback-skip",
      namespaces: [
        {
          key: "nature",
          items: [
            {
              id: "fallback",
              version: "v1",
              kind: "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  fileName: "mime-fallback.bin",
                  byteLength: "mime-fallback".length,
                  source: {
                    url: `${baseUrl}/mime-fallback.bin`,
                  },
                },
              ],
            },
            {
              id: "manifest",
              version: "v1",
              kind: "video",
              assets: [
                {
                  id: "main",
                  role: "primary",
                  kind: "video",
                  fileName: "mime-manifest.bin",
                  byteLength: "mime-manifest".length,
                  source: {
                    url: `${baseUrl}/mime-manifest.bin`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    await cache.syncNow();
    expect(requestCounts["/mime-fallback.bin"]).toBe(1);
    expect(requestCounts["/mime-manifest.bin"]).toBe(1);

    const skippedFallbackItem = await cache.getItem("nature", "fallback");
    expect(skippedFallbackItem?.assets[0]?.mimeType).toBe("video/quicktime");

    const skippedManifestItem = await cache.getItem("nature", "manifest");
    expect(skippedManifestItem?.assets[0]?.mimeType).toBe("video/mp4");
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

  it("returns 404 for media:// URLs with malformed percent-encoding in path", async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });
    await cache.start();
    const handler = await createProtocolHandler(cache, {
      fetchFile: async (_request, filePath) => new Response(readFileSync(filePath, "utf8")),
    });

    const malformed = await handler(new Request("media://asset/foo%GG/bar/main"));
    expect(malformed.status).toBe(404);
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

  it("throws when logFormat is not english or json", () => {
    expect(
      () =>
        new MediaCache({
          storageRoot: createStorageRoot(),
          // @ts-expect-error intentional invalid option for runtime validation
          logFormat: "structured",
          resolveManifest: () => manifests,
        }),
    ).toThrow("Invalid MediaCacheOptions.logFormat");
  });

  it("emits dev_passthrough_ignores_sync_failure_mode when both devPassthrough and serve-last-snapshot are set", () => {
    const logs: MediaCacheLogEvent[] = [];
    new RawMediaCache({
      storageRoot: createStorageRoot(),
      devPassthrough: true,
      onSyncFailure: "serve-last-snapshot",
      onLog: (e) => logs.push(e),
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
      logLevel: "debug",
      onLog: (entry) => {
        logs.push(entry);
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

  it("falls back to the default storage root when storageRoot is blank", async () => {
    const homeRoot = createStorageRoot();
    const originalHome = process.env.HOME;
    const originalLocalAppData = process.env.LOCALAPPDATA;

    process.env.HOME = homeRoot;
    process.env.LOCALAPPDATA = join(homeRoot, "AppData", "Local");

    try {
      const cache = new MediaCache({
        storageRoot: "   ",
        resolveManifest: () => ({
          snapshotId: "blank-storage-root",
          namespaces: [],
        }),
      });

      await cache.start();

      const activeStorageRoot = (cache as unknown as { storageRoot: string | null }).storageRoot;
      const expectedStorageRoot =
        process.platform === "darwin"
          ? join(homeRoot, "Library", "Caches", "electron-offline-content", "media-cache")
          : process.platform === "win32"
            ? join(homeRoot, "AppData", "Local", "electron-offline-content", "media-cache")
            : join(homeRoot, ".cache", "electron-offline-content", "media-cache");
      expect(activeStorageRoot).toBe(expectedStorageRoot);
      expect(existsSync(activeStorageRoot!)).toBe(true);
      const status = await cache.getStatus();
      expect(status.storageRoot).toBe(expectedStorageRoot);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
      rmSync(homeRoot, { recursive: true, force: true });
    }
  });

  it("requires storagePathSegments when storageAppPath is set", async () => {
    const cache = new MediaCache({
      storageAppPath: "temp",
      resolveManifest: () => ({ namespaces: [] }),
    });

    await expect(cache.start()).rejects.toThrow(
      "storagePathSegments is required when storageAppPath is set",
    );
  });

  it("rejects storagePathSegments without storageAppPath", async () => {
    const cache = new MediaCache({
      storagePathSegments: [],
      resolveManifest: () => ({ namespaces: [] }),
    });

    await expect(cache.start()).rejects.toThrow("storagePathSegments requires storageAppPath.");
  });

  it("rejects mixing storageRoot with storageAppPath configuration", async () => {
    const cache = new MediaCache({
      storageRoot: createStorageRoot(),
      storageAppPath: "temp",
      storagePathSegments: [],
      resolveManifest: () => ({ namespaces: [] }),
    });

    await expect(cache.start()).rejects.toThrow(
      "storageRoot cannot be combined with storageAppPath/storagePathSegments",
    );
  });

  it("rejects mixing storageRoot with storagePath", async () => {
    const cache = new MediaCache({
      storageRoot: createStorageRoot(),
      storagePath: { appPath: "temp", segments: [] },
      resolveManifest: () => ({ namespaces: [] }),
    });

    await expect(cache.start()).rejects.toThrow("storageRoot cannot be combined with storagePath");
  });

  it("rejects mixing storagePath with legacy storageAppPath/storagePathSegments", async () => {
    const cache = new MediaCache({
      storagePath: { appPath: "temp", segments: [] },
      storageAppPath: "temp",
      storagePathSegments: [],
      resolveManifest: () => ({ namespaces: [] }),
    });

    await expect(cache.start()).rejects.toThrow(
      "storagePath cannot be combined with storageAppPath/storagePathSegments",
    );
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
      logLevel: "warn",
      onLog: (entry) => {
        logs.push(entry);
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
    manifests = {
      snapshotId: "circular-metadata",
      namespaces: [
        {
          key: "nature",
          metadata: circular as unknown as Record<string, JsonValue>,
          items: [],
        },
      ],
    };

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await expect(cache.start()).rejects.toThrow(DataValidationError);
  });

  it("accepts non-integer manifest byteLength values", async () => {
    const storageRoot = createStorageRoot();
    manifests = {
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
    };

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await cache.start();
    const item = await cache.getItem("nature", "forest");
    expect(item?.assets[0]?.byteLength).toBe(12.5);
  });

  it("tolerates legacy item kinds in staged and active rows", async () => {
    const storageRoot = createStorageRoot();
    manifests = {
      snapshotId: "legacy-item-kind",
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
    };

    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: "throw",
      resolveManifest: () => manifests,
    });

    await cache.start();
    const item = (await cache.getItem("nature", "forest")) as { kind: string } | null;
    expect(item?.kind).toBe("legacy-video");
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
          resolveManifest: async () => ({ namespaces: [] }),
        });
        new RawMediaCache({
          devPassthrough: false,
          resolveManifest: async () => ({ namespaces: [] }),
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

function collectFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return walk(root).sort();
}

function blobPathFor(
  namespace: string,
  itemId: string,
  assetId: string,
  resolvedVersion: string,
  fileName: string,
): string {
  return join(
    "blobs",
    encodeURIComponent(namespace),
    encodeURIComponent(itemId),
    encodeURIComponent(assetId),
    encodeURIComponent(resolvedVersion),
    encodeURIComponent(fileName),
  );
}

function partialPathFor(
  namespace: string,
  itemId: string,
  assetId: string,
  resolvedVersion: string,
  fileName: string,
): string {
  return join(
    "temp",
    encodeURIComponent(namespace),
    encodeURIComponent(itemId),
    encodeURIComponent(assetId),
    encodeURIComponent(resolvedVersion),
    `${encodeURIComponent(fileName)}.part`,
  );
}

function sendStaticBody(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  contentType: string,
  options?: { ignoreRange?: boolean; forceRangeStart?: number },
): void {
  const rangeHeader = options?.ignoreRange ? null : req.headers.range;
  if (!rangeHeader) {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  const start = options?.forceRangeStart ?? parseRangeStart(rangeHeader);
  const partial = body.slice(start);
  res.writeHead(206, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(partial),
    "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
  });
  res.end(partial);
}

function sendInterruptedBody(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  contentType: string,
  chunkSize: number,
): void {
  const start = req.headers.range ? parseRangeStart(req.headers.range) : 0;
  const chunk = body.slice(start, Math.min(start + chunkSize, body.length));
  res.writeHead(start > 0 ? 206 : 200, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body.slice(start)),
    ...(start > 0 ? { "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
  });
  res.flushHeaders();
  res.write(chunk);
  setTimeout(() => {
    res.destroy();
  }, 5);
}

function parseRangeStart(rangeHeader: string): number {
  const match = rangeHeader.match(/^bytes=(\d+)-$/);
  if (!match?.[1]) {
    throw new Error(`Unexpected range header: ${rangeHeader}`);
  }
  return Number.parseInt(match[1], 10);
}

function walk(path: string): string[] {
  const stats = existsSync(path) ? readFileSafe(path) : null;
  if (stats === null) {
    return [];
  }
  if (stats.type === "file") {
    return [path];
  }

  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

function readFileSafe(path: string): { type: "file" | "directory" } | null {
  try {
    const stats = statSync(path);
    return { type: stats.isDirectory() ? "directory" : "file" };
  } catch {
    return null;
  }
}

type RegisterProtocolOptions = NonNullable<Parameters<MediaCacheMain["registerProtocol"]>[0]>;
type AttachIpcOptions = NonNullable<Parameters<MediaCacheMain["attachIpc"]>[0]>;

async function createProtocolHandler(
  cache: Pick<MediaCacheMain, "registerProtocol">,
  options?: Omit<RegisterProtocolOptions, "session">,
): Promise<(request: Request) => Promise<Response>> {
  let handler: ((request: Request) => Promise<Response>) | null = null;
  const fakeSession = {
    protocol: {
      handle: (_scheme: string, nextHandler: (request: Request) => Promise<Response>) => {
        handler = nextHandler;
      },
    },
  } as unknown as RegisterProtocolOptions["session"];

  await cache.registerProtocol({
    ...options,
    session: fakeSession,
  });

  if (!handler) {
    throw new Error("Protocol handler was not registered");
  }

  return handler;
}

async function createIpcHandlers(
  cache: Pick<MediaCacheMain, "attachIpc">,
): Promise<Map<string, (...args: unknown[]) => Promise<unknown>>> {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const fakeIpcMain = {
    handle: (
      channel: string,
      listener: (_event: unknown, ...args: unknown[]) => Promise<unknown>,
    ) => {
      handlers.set(channel, (...args) => listener({}, ...args));
    },
  } as unknown as AttachIpcOptions["ipcMain"];

  await cache.attachIpc({
    ipcMain: fakeIpcMain,
  });

  return handlers;
}

function mimeManifest(baseUrl: string): ManifestInput {
  const assetDefinitions = [
    ["main", "sample.mp4", `${baseUrl}/main.mp4`],
    ["webm", "sample.webm", `${baseUrl}/main.mp4`],
    ["mov", "sample.mov", `${baseUrl}/main.mp4`],
    ["jpg", "sample.jpg", `${baseUrl}/poster.jpg`],
    ["jpeg", "sample.jpeg", `${baseUrl}/poster.jpg`],
    ["png", "sample.png", `${baseUrl}/poster.jpg`],
    ["gif", "sample.gif", `${baseUrl}/poster.jpg`],
    ["webp", "sample.webp", `${baseUrl}/poster.jpg`],
    ["vtt", "sample.vtt", `${baseUrl}/sub.vtt`],
    ["srt", "sample.srt", `${baseUrl}/sub.vtt`],
    ["mp3", "sample.mp3", `${baseUrl}/main.mp4`],
    ["wav", "sample.wav", `${baseUrl}/main.mp4`],
    ["html", "sample.html", `${baseUrl}/sub.vtt`],
    ["txt", "sample.txt", `${baseUrl}/sub.vtt`],
    ["json", "sample.json", `${baseUrl}/sub.vtt`],
    ["pdf", "sample.pdf", `${baseUrl}/main.mp4`],
  ] as const;
  type MimeAssetId = (typeof assetDefinitions)[number][0];
  const kindByAssetId: Record<MimeAssetId, MediaAssetDefinition["kind"]> = {
    main: "video",
    webm: "video",
    mov: "video",
    jpg: "image",
    jpeg: "image",
    png: "image",
    gif: "image",
    webp: "image",
    vtt: "subtitle",
    srt: "subtitle",
    mp3: "audio",
    wav: "audio",
    html: "html",
    txt: "text",
    json: "document",
    pdf: "document",
  };

  return {
    snapshotId: "mime-types",
    namespaces: [
      {
        key: "mime",
        items: [
          {
            id: "types",
            version: "v1",
            kind: "document",
            assets: assetDefinitions.map(([id, fileName, url], index) => ({
              id,
              role: index === 0 ? "primary" : id,
              kind: kindByAssetId[id],
              fileName,
              source: {
                url,
              },
            })),
          },
        ],
      },
    ],
  };
}
