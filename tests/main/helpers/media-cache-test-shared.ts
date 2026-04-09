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
import { DataValidationError } from "../../../src/shared/errors.js";
import { IndexTag, type JsonValue } from "../../../src/shared/types.js";
import { mediaCacheStoragePathSchema, parseWithSchema } from "../../../src/internal/validation.js";
import { createMediaStore, type MediaStore } from "../../../src/main/store.js";

/**
 * Build a MediaStore from a flat list of asset definitions.
 * This replaces the old `recordManifest()` helper.
 */
export interface TestAsset {
  key: string;
  version: string;
  mimeType: string;
  fileName?: string;
  byteLength?: number;
  source: { url: string; method?: "GET"; headers?: Record<string, string> };
  metadata?: Record<string, JsonValue>;
  indexes?: Record<string, string | string[]>;
}

export function buildTestStore(input: {
  snapshotId?: string;
  retrievedAt?: string;
  expiresAt?: string;
  indexes?: Array<{
    name: string;
    cardinality?: "single" | "multi";
    required?: boolean;
  }>;
  assets: TestAsset[];
}): MediaStore {
  const store = createMediaStore({
    snapshotId: input.snapshotId,
    retrievedAt: input.retrievedAt,
    expiresAt: input.expiresAt,
  });

  const indexHandles = new Map<string, ReturnType<typeof store.defineIndex>>();
  if (input.indexes) {
    for (const idx of input.indexes) {
      indexHandles.set(
        idx.name,
        store.defineIndex(idx.name, {
          cardinality: idx.cardinality,
          required: idx.required,
        }),
      );
    }
  }

  for (const asset of input.assets) {
    const indexTags: IndexTag[] = [];
    if (asset.indexes) {
      for (const [name, value] of Object.entries(asset.indexes)) {
        const handle = indexHandles.get(name);
        if (handle) {
          indexTags.push(handle(value));
        }
      }
    }
    store.add(asset.key, {
      version: asset.version,
      mimeType: asset.mimeType,
      fileName: asset.fileName,
      byteLength: asset.byteLength,
      source: asset.source,
      metadata: asset.metadata,
      indexes: indexTags.length > 0 ? indexTags : undefined,
    });
  }

  return store;
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

type MediaCacheCtorOptions = ConstructorParameters<typeof RawMediaCacheBase>[0];

function normalizeTestOptions(options: TestMediaCacheOptions): MediaCacheCtorOptions {
  const { storageRoot, storagePath, ...rest } = options;

  if (storagePath !== undefined) {
    return {
      ...rest,
      storagePath: parseWithSchema(mediaCacheStoragePathSchema, storagePath, "storage path"),
    };
  }

  if (storageRoot !== undefined) {
    return {
      ...rest,
      storagePath: {
        appPath: "temp",
        segments: [basename(storageRoot)],
      },
    };
  }

  throw new DataValidationError(
    "Test cache options must include `storageRoot` or `storagePath` for offline mode.",
  );
}

function mergeTestDeps(deps?: TestMediaCacheDeps): TestMediaCacheDeps {
  return {
    ...deps,
    resolveAppPath: deps?.resolveAppPath ?? testResolveAppPath,
  };
}

export class RawMediaCache extends RawMediaCacheBase {
  constructor(options: TestMediaCacheOptions, deps?: TestMediaCacheDeps) {
    super(normalizeTestOptions(options), mergeTestDeps(deps));
  }
}

export class MediaCache extends RawMediaCache {
  constructor(options: TestMediaCacheOptions, deps?: TestMediaCacheDeps) {
    super({ ...options, devPassthrough: false }, deps);
  }
}

export function createMediaCache(options: TestMediaCacheOptions) {
  return new RawMediaCache({ ...options, devPassthrough: false });
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
      child.stdout.off("data", onStdout);
      child.off("exit", onExit);
      child.stderr.off("data", onStderr);
      if (!child.killed && child.exitCode === null) {
        child.kill();
        setTimeout(() => {
          if (!child.killed && child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }, 200);
      }
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
  createDefaultStore: () => MediaStore;
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

  function createDefaultStore(): MediaStore {
    return buildTestStore({
      snapshotId: "initial",
      assets: [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "main.mp4",
          byteLength: 9,
          source: { url: `${baseUrl}/main.mp4` },
        },
        {
          key: "nature/forest/poster",
          version: "v1",
          mimeType: "image/jpeg",
          fileName: "poster.jpg",
          byteLength: 6,
          source: { url: `${baseUrl}/poster.jpg` },
        },
        {
          key: "nature.flowerVideos/rose/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "flower.mp4",
          byteLength: 12,
          source: { url: `${baseUrl}/flower.mp4` },
        },
        {
          key: "nature.flowerVideos/rose/captions",
          version: "v1",
          mimeType: "text/vtt",
          fileName: "sub.vtt",
          byteLength: 6,
          source: { url: `${baseUrl}/sub.vtt` },
        },
      ],
    });
  }

  return {
    baseUrl,
    server,
    counters,
    resetCounters,
    createDefaultStore,
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

export function blobPathFor(assetKey: string, version: string, fileName: string): string {
  return join(
    "blobs",
    encodeURIComponent(assetKey),
    encodeURIComponent(version),
    encodeURIComponent(fileName),
  );
}

export function partialPathFor(assetKey: string, version: string, fileName: string): string {
  return join(
    "temp",
    encodeURIComponent(assetKey),
    encodeURIComponent(version),
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

export function mimeManifestStore(baseUrl: string): MediaStore {
  const mimeAssets: Array<{
    key: string;
    fileName: string;
    mimeType: string;
    source: { url: string };
  }> = [
    {
      key: "mime/types/main",
      fileName: "sample.mp4",
      mimeType: "video/mp4",
      source: { url: `${baseUrl}/main.mp4` },
    },
    {
      key: "mime/types/webm",
      fileName: "sample.webm",
      mimeType: "video/webm",
      source: { url: `${baseUrl}/main.mp4` },
    },
    {
      key: "mime/types/mov",
      fileName: "sample.mov",
      mimeType: "video/quicktime",
      source: { url: `${baseUrl}/main.mp4` },
    },
    {
      key: "mime/types/jpg",
      fileName: "sample.jpg",
      mimeType: "image/jpeg",
      source: { url: `${baseUrl}/poster.jpg` },
    },
    {
      key: "mime/types/jpeg",
      fileName: "sample.jpeg",
      mimeType: "image/jpeg",
      source: { url: `${baseUrl}/poster.jpg` },
    },
    {
      key: "mime/types/png",
      fileName: "sample.png",
      mimeType: "image/png",
      source: { url: `${baseUrl}/poster.jpg` },
    },
    {
      key: "mime/types/gif",
      fileName: "sample.gif",
      mimeType: "image/gif",
      source: { url: `${baseUrl}/poster.jpg` },
    },
    {
      key: "mime/types/webp",
      fileName: "sample.webp",
      mimeType: "image/webp",
      source: { url: `${baseUrl}/poster.jpg` },
    },
    {
      key: "mime/types/vtt",
      fileName: "sample.vtt",
      mimeType: "text/vtt",
      source: { url: `${baseUrl}/sub.vtt` },
    },
    {
      key: "mime/types/srt",
      fileName: "sample.srt",
      mimeType: "application/x-subrip",
      source: { url: `${baseUrl}/sub.vtt` },
    },
    {
      key: "mime/types/mp3",
      fileName: "sample.mp3",
      mimeType: "audio/mpeg",
      source: { url: `${baseUrl}/main.mp4` },
    },
    {
      key: "mime/types/wav",
      fileName: "sample.wav",
      mimeType: "audio/wav",
      source: { url: `${baseUrl}/main.mp4` },
    },
    {
      key: "mime/types/html",
      fileName: "sample.html",
      mimeType: "text/html",
      source: { url: `${baseUrl}/sub.vtt` },
    },
    {
      key: "mime/types/txt",
      fileName: "sample.txt",
      mimeType: "text/plain",
      source: { url: `${baseUrl}/sub.vtt` },
    },
    {
      key: "mime/types/json",
      fileName: "sample.json",
      mimeType: "application/json",
      source: { url: `${baseUrl}/sub.vtt` },
    },
    {
      key: "mime/types/pdf",
      fileName: "sample.pdf",
      mimeType: "application/pdf",
      source: { url: `${baseUrl}/main.mp4` },
    },
  ];

  return buildTestStore({
    snapshotId: "mime-types",
    assets: mimeAssets.map((a) => ({
      key: a.key,
      version: "v1",
      mimeType: a.mimeType,
      fileName: a.fileName,
      source: a.source,
    })),
  });
}
