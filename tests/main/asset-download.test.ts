import { describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { AssetDownloader, type AssetDownloadTarget } from "../../src/main/asset-download.js";
import { StorageLimitError } from "../../src/shared/errors.js";

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "asset-download-test-"));
}

function createTarget(overrides: Partial<AssetDownloadTarget> = {}): AssetDownloadTarget {
  return {
    assetKey: "nature/forest/main",
    fileName: "main.mp4",
    version: "v1",
    byteLength: 9,
    request: {
      url: "https://example.test/main.mp4",
    },
    ...overrides,
  };
}

function createDownloader(
  root: string,
  fetchImpl: typeof globalThis.fetch,
  options?: {
    reserveFreeBytes?: number;
  },
): AssetDownloader {
  return new AssetDownloader(
    root,
    {
      fetchImpl,
      sleep: async () => undefined,
      statfs: async (path) =>
        statfsSync(path) as Awaited<ReturnType<typeof import("node:fs/promises").statfs>>,
    },
    {
      reserveFreeBytes: options?.reserveFreeBytes,
      emitLog: () => undefined,
    },
  );
}

function textResponse(
  body: string,
  init?: {
    status?: number;
    headers?: HeadersInit;
  },
): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: init?.headers,
  });
}

describe("AssetDownloader paths and cleanup", () => {
  it("builds encoded partial paths and discounts existing partial bytes", () => {
    const root = createRoot();
    const downloader = createDownloader(root, vi.fn());
    const target = createTarget({
      assetKey: "nature videos/forest/loop/poster#1",
      fileName: "main cut.mp4",
      byteLength: 20,
    });
    const partialPath = downloader.partialDownloadPath(target);

    expect(partialPath).toContain("nature%20videos%2Fforest%2Floop%2Fposter%231");
    expect(partialPath).toContain("main%20cut.mp4.part");

    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(partialPath, "partial");
    expect(downloader.remainingDownloadBytes(target)).toBe(13);
  });

  it("removes obsolete partial files while keeping resumable targets", () => {
    const root = createRoot();
    const downloader = createDownloader(root, vi.fn());
    const current = createTarget();
    const currentPartial = downloader.partialDownloadPath(current);
    const stalePartial = downloader.partialDownloadPath(createTarget({ version: "old-version" }));
    mkdirSync(dirname(currentPartial), { recursive: true });
    mkdirSync(dirname(stalePartial), { recursive: true });
    writeFileSync(currentPartial, "current");
    writeFileSync(stalePartial, "stale");

    downloader.cleanupObsoletePartialDownloads([current]);

    expect(existsSync(currentPartial)).toBe(true);
    expect(existsSync(stalePartial)).toBe(false);
  });
});

describe("AssetDownloader storage root containment", () => {
  it("keeps dot-only manifest segments inside the storage root", () => {
    const root = createRoot();
    const downloader = createDownloader(root, vi.fn());
    const target = createTarget({ assetKey: "..", version: "..", fileName: ".." });
    const partialPath = downloader.partialDownloadPath(target);

    expect(relative(root, partialPath).startsWith("..")).toBe(false);
    expect(partialPath).toContain("%2E%2E");
  });

  it("refuses to delete stored paths that escape the storage root", async () => {
    const root = createRoot();
    const target = createTarget({
      assetKey: "..",
      version: "..",
      fileName: "escape-target.bin",
      byteLength: 4,
    });
    const downloader = createDownloader(root, async () => textResponse("data"));
    const outsidePath = join(root, "..", "escape-target.bin");
    writeFileSync(outsidePath, "outside-cache");

    try {
      const result = await downloader.downloadAsset(target, () => undefined);

      expect(readFileSync(outsidePath, "utf8")).toBe("outside-cache");
      expect(relative(root, join(root, result.relativePath)).startsWith("..")).toBe(false);
      expect(readFileSync(join(root, result.relativePath), "utf8")).toBe("data");
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  it("does not prune sibling directories whose name shares the storage root as a prefix", () => {
    const root = createRoot();
    const siblingRoot = `${root}2`;
    const siblingDirectory = join(siblingRoot, "empty");
    mkdirSync(siblingDirectory, { recursive: true });
    const downloader = createDownloader(root, vi.fn());
    const stalePartial = downloader.partialDownloadPath(createTarget({ version: "old-version" }));
    mkdirSync(dirname(stalePartial), { recursive: true });
    writeFileSync(stalePartial, "stale");

    try {
      downloader.cleanupObsoletePartialDownloads([]);

      expect(existsSync(stalePartial)).toBe(false);
      expect(existsSync(siblingDirectory)).toBe(true);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(siblingRoot, { recursive: true, force: true });
    }
  });
});

describe("AssetDownloader range and retry behaviour", () => {
  it("resumes a partial download with a range request and commits the blob", async () => {
    const root = createRoot();
    const target = createTarget({ fileName: "resumable.mp4", byteLength: "resume-data".length });
    const ranges: string[] = [];
    const downloader = createDownloader(root, async (_url, init) => {
      const range = new Headers(init?.headers).get("range") ?? "";
      ranges.push(range);
      return textResponse("-data", {
        status: 206,
        headers: {
          "content-range": "bytes 6-10/11",
          "content-type": "video/mp4",
        },
      });
    });
    const partialPath = downloader.partialDownloadPath(target);
    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(partialPath, "resume");

    const result = await downloader.downloadAsset(target, () => undefined);

    expect(ranges).toEqual(["bytes=6-"]);
    expect(result.fallbackMimeType).toBe("video/mp4");
    expect(existsSync(partialPath)).toBe(false);
    expect(readFileSync(join(root, result.relativePath), "utf8")).toBe("resume-data");
  });

  it("restarts from byte zero when a server ignores a range request", async () => {
    const root = createRoot();
    const target = createTarget({
      fileName: "range-ignored.mp4",
      byteLength: "range-ignore".length,
    });
    const ranges: string[] = [];
    const downloader = createDownloader(root, async (_url, init) => {
      const range = new Headers(init?.headers).get("range") ?? "";
      ranges.push(range);
      return range
        ? textResponse("range-ignore")
        : textResponse("range-ignore", { headers: { "content-type": "video/mp4" } });
    });
    const partialPath = downloader.partialDownloadPath(target);
    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(partialPath, "range");

    const result = await downloader.downloadAsset(target, () => undefined);

    expect(ranges).toEqual(["bytes=5-", ""]);
    expect(readFileSync(join(root, result.relativePath), "utf8")).toBe("range-ignore");
  });

  it("restarts from byte zero when a server returns mismatched content range", async () => {
    const root = createRoot();
    const target = createTarget({
      fileName: "range-mismatch.mp4",
      byteLength: "range-mismatch".length,
    });
    const ranges: string[] = [];
    const downloader = createDownloader(root, async (_url, init) => {
      const range = new Headers(init?.headers).get("range") ?? "";
      ranges.push(range);
      return range
        ? textResponse("ismatch", {
            status: 206,
            headers: { "content-range": "bytes 4-12/13" },
          })
        : textResponse("range-mismatch");
    });
    const partialPath = downloader.partialDownloadPath(target);
    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(partialPath, "range");

    const result = await downloader.downloadAsset(target, () => undefined);

    expect(ranges).toEqual(["bytes=5-", ""]);
    expect(readFileSync(join(root, result.relativePath), "utf8")).toBe("range-mismatch");
  });

  it("restarts from byte zero after a 416 range response", async () => {
    const root = createRoot();
    const target = createTarget({ fileName: "range-416.mp4", byteLength: "range-416".length });
    const ranges: string[] = [];
    const downloader = createDownloader(root, async (_url, init) => {
      const range = new Headers(init?.headers).get("range") ?? "";
      ranges.push(range);
      return range
        ? textResponse("", { status: 416, headers: { "content-range": "bytes */9" } })
        : textResponse("range-416");
    });
    const partialPath = downloader.partialDownloadPath(target);
    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(partialPath, "range-416");

    const result = await downloader.downloadAsset(target, () => undefined);

    expect(ranges).toEqual(["bytes=9-", ""]);
    expect(readFileSync(join(root, result.relativePath), "utf8")).toBe("range-416");
  });

  it("preserves partial files after exhausting retryable failures", async () => {
    const root = createRoot();
    const target = createTarget({ fileName: "retry.mp4", byteLength: "retry-bytes".length });
    const downloader = createDownloader(
      root,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("retry"));
              queueMicrotask(() => {
                controller.error(new Error("terminated"));
              });
            },
          }),
          { status: 200 },
        ),
    );

    await expect(downloader.downloadAsset(target, () => undefined)).rejects.toThrow("terminated");

    const partialPath = downloader.partialDownloadPath(target);
    expect(existsSync(partialPath)).toBe(true);
  });

  it("deletes partial files after terminal failures", async () => {
    const root = createRoot();
    const target = createTarget({ fileName: "terminal.mp4" });
    const downloader = createDownloader(root, async () => textResponse("missing", { status: 404 }));
    const partialPath = downloader.partialDownloadPath(target);
    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(partialPath, "partial");

    await expect(downloader.downloadAsset(target, () => undefined)).rejects.toThrow(
      "Download failed",
    );

    expect(existsSync(partialPath)).toBe(false);
  });

  it("classifies ENOSPC stream errors as storage limit errors and deletes the partial", async () => {
    const root = createRoot();
    const target = createTarget({ fileName: "enospc.mp4" });
    const downloader = createDownloader(
      root,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x"));
              queueMicrotask(() => {
                controller.error(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
              });
            },
          }),
          { status: 200 },
        ),
    );

    await expect(downloader.downloadAsset(target, () => undefined)).rejects.toThrow(
      StorageLimitError,
    );

    expect(existsSync(downloader.partialDownloadPath(target))).toBe(false);
  });
});

describe("AssetDownloader storage commit guard", () => {
  it("checks reserveFreeBytes before committing a completed download", async () => {
    const root = createRoot();
    const stats = statfsSync(root);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const downloader = createDownloader(root, async () => textResponse("main"), {
      reserveFreeBytes: availableBytes + 1,
    });

    await expect(downloader.ensureFileSpaceCommit()).rejects.toThrow(StorageLimitError);
  });
});
