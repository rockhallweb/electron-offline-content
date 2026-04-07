import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MediaCache as RawMediaCacheBase,
  resetMediaCacheProtocolRegistrationStateForTests,
  type MediaCacheMain,
} from "../../../src/main/media-cache.js";
import type {
  JsonValue,
  MediaAssetValue,
  MediaCacheManifest,
  MediaItemValue,
  SyncManifestAsset,
} from "../../../src/shared/types.js";

/** Build a record-shaped manifest from legacy `{ key, items: [{ id, assets: [{ id, ... }] }] }[]` test fixtures. */
type LegacyManifestAsset = { id: string } & MediaAssetValue;
type LegacyManifestItem = { id: string; assets: LegacyManifestAsset[] } & Omit<
  MediaItemValue,
  "assets"
>;
type LegacyManifestNamespace = {
  key: string;
  label?: string;
  metadata?: Record<string, JsonValue>;
  items: LegacyManifestItem[];
};

export function recordManifest(input: {
  snapshotId?: string;
  retrievedAt?: string;
  expiresAt?: string;
  namespaces: LegacyManifestNamespace[];
}): MediaCacheManifest {
  const namespaces: MediaCacheManifest["namespaces"] = {};
  for (const ns of input.namespaces) {
    const { key, items, ...nsRest } = ns;
    namespaces[key] = {
      ...nsRest,
      items: Object.fromEntries(
        items.map((item) => {
          const { id, assets, ...itemRest } = item;
          return [
            id,
            {
              ...itemRest,
              assets: Object.fromEntries(
                assets.map((a) => {
                  const { id: assetId, ...assetRest } = a;
                  return [assetId, assetRest];
                }),
              ),
            },
          ];
        }),
      ),
    };
  }
  return {
    snapshotId: input.snapshotId,
    retrievedAt: input.retrievedAt,
    expiresAt: input.expiresAt,
    namespaces,
  };
}

export type TestMediaCacheOptions = Omit<
  ConstructorParameters<typeof RawMediaCacheBase>[0],
  "storagePath"
> & {
  storagePath?: ConstructorParameters<typeof RawMediaCacheBase>[0]["storagePath"];
  storageRoot?: string;
};
export type TestMediaCacheDeps = ConstructorParameters<typeof RawMediaCacheBase>[1];

function testResolveAppPath(appPath: "temp"): Promise<string>;
function testResolveAppPath(appPath: string): Promise<string>;
async function testResolveAppPath(appPath: string): Promise<string> {
  if (appPath !== "temp") {
    throw new Error(`Unexpected test appPath: ${appPath}`);
  }
  return tmpdir();
}

function normalizeTestOptions(
  options: TestMediaCacheOptions,
): ConstructorParameters<typeof RawMediaCacheBase>[0] {
  if (options.storageRoot === undefined) {
    return options as ConstructorParameters<typeof RawMediaCacheBase>[0];
  }

  const { storageRoot, ...rest } = options;
  return {
    ...rest,
    storagePath: {
      appPath: "temp",
      segments: [basename(storageRoot)],
    },
  };
}

function mergeTestDeps(deps?: TestMediaCacheDeps): TestMediaCacheDeps {
  return {
    resolveAppPath: deps?.resolveAppPath ?? testResolveAppPath,
    ...deps,
  };
}

export class RawMediaCache extends RawMediaCacheBase {
  constructor(options: TestMediaCacheOptions, deps?: TestMediaCacheDeps) {
    super(normalizeTestOptions(options), mergeTestDeps(deps));
  }
}

export class MediaCache extends RawMediaCache {
  constructor(options: TestMediaCacheOptions, deps?: TestMediaCacheDeps) {
    super({ devPassthrough: false, ...options }, deps);
  }
}

export function createMediaCache(options: TestMediaCacheOptions) {
  return new RawMediaCache({ devPassthrough: false, ...options });
}

export const electronSupportsProtocolRegistration = (() => {
  try {
    const req = createRequire(import.meta.url);
    const electron = req("electron") as typeof import("electron");
    return typeof electron.protocol?.registerSchemesAsPrivileged === "function";
  } catch {
    return false;
  }
})();

export const storageRootLockFixturePath = fileURLToPath(
  new URL("../fixtures/hold-storage-root-lock.mjs", import.meta.url),
);

export function createStorageRoot(): string {
  return mkdtempSync(join(tmpdir(), "media-cache-test-"));
}

export async function startExternalStorageRootLock(
  storageRoot: string,
): Promise<{ stop(): Promise<void> }> {
  const child = spawn(process.execPath, [storageRootLockFixturePath, storageRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    const onExit = (code: number | null) => {
      reject(new Error(`storage-root lock fixture exited before ready (code: ${code ?? "null"})`));
    };
    const onStdout = (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("READY")) {
        child.stdout.off("data", onStdout);
        child.off("exit", onExit);
        resolve();
      }
    };
    const onStderr = (chunk: Buffer) => {
      reject(new Error(`storage-root lock fixture stderr: ${chunk.toString("utf8").trim()}`));
    };

    child.once("exit", onExit);
    child.stdout.on("data", onStdout);
    child.stderr.once("data", onStderr);
  });

  return {
    async stop() {
      if (child.killed || child.exitCode !== null) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
        child.kill("SIGTERM");
      });
    },
  };
}

export function createNoSleepCache(options: ConstructorParameters<typeof MediaCache>[0]) {
  return new MediaCache(options, {
    sleep: async () => undefined,
  });
}

export type MediaCacheTestCounters = {
  requestCounts: Record<string, number>;
  requestMethods: Record<string, string[]>;
  requestRanges: Record<string, string[]>;
  requestAuthHeaders: Record<string, string[]>;
};

export type MediaCacheTestFixture = {
  baseUrl: string;
  server: Server;
  counters: MediaCacheTestCounters;
  resetCounters: () => void;
  createDefaultManifests: () => MediaCacheManifest;
  close: () => Promise<void>;
};

function parseRangeStart(rangeHeader: string): number {
  const match = rangeHeader.match(/^bytes=(\d+)-$/);
  if (!match?.[1]) {
    throw new Error(`Unexpected range header: ${rangeHeader}`);
  }
  return Number.parseInt(match[1], 10);
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

export async function createMediaCacheTestFixture(): Promise<MediaCacheTestFixture> {
  const counters: MediaCacheTestCounters = {
    requestCounts: {},
    requestMethods: {},
    requestRanges: {},
    requestAuthHeaders: {},
  };

  function resetCounters(): void {
    counters.requestCounts = {};
    counters.requestMethods = {};
    counters.requestRanges = {};
    counters.requestAuthHeaders = {};
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "/";
    counters.requestCounts[path] = (counters.requestCounts[path] ?? 0) + 1;
    counters.requestMethods[path] ??= [];
    counters.requestMethods[path].push(req.method ?? "GET");
    counters.requestRanges[path] ??= [];
    counters.requestRanges[path].push(req.headers.range ?? "");
    counters.requestAuthHeaders[path] ??= [];
    counters.requestAuthHeaders[path].push(
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
      if (counters.requestCounts[path] === 1) {
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
      if (req.headers.range && counters.requestCounts[path] === 1) {
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
  const baseUrl = `http://127.0.0.1:${address.port}`;

  function createDefaultManifests(): MediaCacheManifest {
    return recordManifest({
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
    });
  }

  return {
    baseUrl,
    server,
    counters,
    resetCounters,
    createDefaultManifests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export { resetMediaCacheProtocolRegistrationStateForTests };

export function collectFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return walk(root).sort();
}

export function blobPathFor(
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

export function partialPathFor(
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

function walk(path: string): string[] {
  const stats = readFileSafe(path);
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

export async function createProtocolHandler(
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

export async function createIpcHandlers(
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

export function mimeManifest(baseUrl: string): MediaCacheManifest {
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
  const kindByAssetId: Record<MimeAssetId, SyncManifestAsset["kind"]> = {
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

  return recordManifest({
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
  });
}
