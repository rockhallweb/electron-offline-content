import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { join } from "node:path";
import { MediaCache, createMediaCache } from "../../src/main/media-cache.js";
import { normalizeManifest } from "../../src/shared/normalize.js";
import { ManifestValidationError, StorageLimitError } from "../../src/shared/errors.js";
import type {
  ManifestInput,
  MediaAssetDefinition,
  MediaCacheLogEvent,
} from "../../src/shared/types.js";

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

describe("media cache sync and queries", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl = "";
  let requestCounts: Record<string, number>;
  let requestRanges: Record<string, string[]>;
  let manifests: ManifestInput;

  beforeAll(async () => {
    requestCounts = {};
    requestRanges = {};
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url ?? "/";
      requestCounts[path] = (requestCounts[path] ?? 0) + 1;
      requestRanges[path] ??= [];
      requestRanges[path].push(req.headers.range ?? "");

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
    requestRanges = {};
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
      resolveManifest: () => manifests,
    });

    await cache.start();

    const item = await cache.getItem("nature", "forest");
    expect(item?.title).toBe("Forest");
    expect(item?.assets[0]?.url).toBe("media://asset/nature/forest/main");

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

  it("skips unchanged downloads and redownloads when the version changes", async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
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
          ensureFileSpaceCommit(tempPath: string): Promise<void>;
        }
      ).ensureFileSpaceCommit(partialPath),
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

type RegisterProtocolOptions = NonNullable<Parameters<MediaCache["registerProtocol"]>[0]>;

async function createProtocolHandler(
  cache: MediaCache,
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
