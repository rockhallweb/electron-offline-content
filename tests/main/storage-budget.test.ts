import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { StorageBudget, partialDownloadPath } from "../../src/main/storage-budget.js";
import { StorageLimitError } from "../../src/shared/errors.js";

describe("StorageBudget", () => {
  it("applies partial download discounts during reserve preflight", async () => {
    const root = mkdtempSync(join(tmpdir(), "storage-budget-partial-"));
    try {
      const download = {
        assetKey: "asset-key",
        version: "v1",
        fileName: "video.mp4",
        byteLength: 100,
      };
      writeFile(root, partialDownloadPath(root, download), "x".repeat(40));
      const budget = createBudget(root, { availableBytes: 70, reserveFreeBytes: 10 });

      await expect(budget.assertPreflight([download])).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws StorageLimitError when cache bytes would exceed maxCacheBytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "storage-budget-max-"));
    try {
      writeFile(root, join(root, "blobs", "existing.bin"), "x".repeat(80));
      const budget = createBudget(root, { maxCacheBytes: 100 });

      await expect(
        budget.assertPreflight([
          {
            assetKey: "asset-key",
            version: "v1",
            fileName: "video.mp4",
            byteLength: 25,
          },
        ]),
      ).rejects.toThrow(StorageLimitError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks reserve again at commit time", async () => {
    const root = mkdtempSync(join(tmpdir(), "storage-budget-commit-"));
    try {
      const budget = createBudget(root, { availableBytes: 9, reserveFreeBytes: 10 });

      await expect(budget.assertCommit()).rejects.toThrow(StorageLimitError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createBudget(
  storageRoot: string,
  options: {
    availableBytes?: number;
    maxCacheBytes?: number;
    reserveFreeBytes?: number;
  },
): StorageBudget {
  const availableBytes = options.availableBytes ?? 1_000;
  return new StorageBudget(
    storageRoot,
    {
      statfs: async () =>
        ({
          bavail: availableBytes,
          bsize: 1,
        }) as Awaited<ReturnType<typeof import("node:fs/promises").statfs>>,
    },
    {
      maxCacheBytes: options.maxCacheBytes,
      reserveFreeBytes: options.reserveFreeBytes,
      emitLog: () => undefined,
    },
  );
}

function writeFile(root: string, path: string, contents: string): void {
  const absolutePath = path.startsWith(root) ? path : join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}
