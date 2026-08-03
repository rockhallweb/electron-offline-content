import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  partialDownloadBytes,
  partialDownloadPath,
  type QueuedAssetDownloadTarget,
} from "../../src/main/asset-download.js";
import {
  DEFAULT_RESERVE_FREE_BYTES,
  StorageBudget,
  type BytesOnDiskOps,
  type StorageBudgetLogHandler,
} from "../../src/main/storage-budget.js";
import { StorageLimitError } from "../../src/shared/errors.js";
import type { JsonValue } from "../../src/shared/types.js";

type StatFsResult = Awaited<ReturnType<typeof import("node:fs/promises").statfs>>;

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "storage-budget-test-"));
}

function createTarget(
  overrides: Partial<QueuedAssetDownloadTarget> = {},
): QueuedAssetDownloadTarget {
  return {
    assetKey: "nature/forest/main",
    fileName: "main.mp4",
    version: "v1",
    byteLength: 9,
    ...overrides,
  };
}

function stubStatFs(root: string, availableBytes: number): (path: string) => Promise<StatFsResult> {
  return async (path) => {
    const base = statfsSync(path.startsWith(root) ? path : root);
    return {
      ...base,
      bsize: 1n,
      bavail: BigInt(availableBytes),
    } as unknown as StatFsResult;
  };
}

/** Disk ops that delete `vanishingPath` on first stat, simulating a concurrent unlink. */
function vanishingEntryDiskOps(vanishingPath: string): BytesOnDiskOps {
  return {
    readdirSync: (path) => readdirSync(path),
    statSync: (path, options) => {
      if (path === vanishingPath) {
        rmSync(vanishingPath, { force: true });
      }
      return statSync(path, options);
    },
  };
}

function createBudget(
  root: string,
  options?: {
    maxCacheBytes?: number;
    reserveFreeBytes?: number;
    availableBytes?: number;
    emitLog?: StorageBudgetLogHandler;
    disk?: BytesOnDiskOps;
  },
): StorageBudget {
  return new StorageBudget(
    root,
    { partialDownloadBytes: (download) => partialDownloadBytes(root, download) },
    {
      statfs:
        options?.availableBytes === undefined
          ? async (path) => statfsSync(path) as unknown as StatFsResult
          : stubStatFs(root, options.availableBytes),
      disk: options?.disk,
    },
    {
      maxCacheBytes: options?.maxCacheBytes,
      reserveFreeBytes: options?.reserveFreeBytes,
      emitLog: options?.emitLog ?? (() => undefined),
    },
  );
}

describe("StorageBudget partial download discounts", () => {
  it("discounts existing partial bytes from remaining download bytes", () => {
    const root = createRoot();
    const budget = createBudget(root);
    const target = createTarget({ byteLength: 20 });
    const partialPath = partialDownloadPath(root, target);
    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(partialPath, "partial");

    expect(budget.remainingDownloadBytes(target)).toBe(13);
  });

  it("treats missing partial files as zero downloaded bytes", () => {
    const root = createRoot();
    const budget = createBudget(root);

    expect(budget.remainingDownloadBytes(createTarget({ byteLength: 20 }))).toBe(20);
  });

  it("never reports negative remaining bytes when the partial exceeds the estimate", () => {
    const root = createRoot();
    const budget = createBudget(root);
    const target = createTarget({ byteLength: 3 });
    const partialPath = partialDownloadPath(root, target);
    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(partialPath, "partial");

    expect(budget.remainingDownloadBytes(target)).toBe(0);
  });
});

describe("StorageBudget preflight download budget", () => {
  it("throws when estimated cache size exceeds maxCacheBytes, counting current blob bytes", async () => {
    const root = createRoot();
    const blobPath = join(root, "blobs", "existing", "v1", "existing.bin");
    mkdirSync(dirname(blobPath), { recursive: true });
    writeFileSync(blobPath, "1234567890");
    const events: Array<{ event: string; fields?: Record<string, JsonValue | undefined> }> = [];
    const budget = createBudget(root, {
      maxCacheBytes: 15,
      reserveFreeBytes: 0,
      emitLog: (_level, event, fields) => events.push({ event, fields }),
    });

    await expect(budget.ensureDownloadBudget([createTarget({ byteLength: 6 })])).rejects.toThrow(
      "Estimated cache size 16 exceeds maxCacheBytes 15.",
    );
    expect(events).toEqual([
      {
        event: "storage_limit_exceeded",
        fields: {
          current_bytes: 10,
          estimated_download_bytes: 6,
          max_cache_bytes: 15,
        },
      },
    ]);
  });

  it("passes when estimated cache size stays within maxCacheBytes", async () => {
    const root = createRoot();
    const budget = createBudget(root, { maxCacheBytes: 15, reserveFreeBytes: 0 });

    await expect(
      budget.ensureDownloadBudget([createTarget({ byteLength: 15 })]),
    ).resolves.toBeUndefined();
  });

  it("throws when the estimated download would dip below the default reserve", async () => {
    const root = createRoot();
    const byteLength = 1000;
    const events: Array<{ event: string; fields?: Record<string, JsonValue | undefined> }> = [];
    const budget = createBudget(root, {
      availableBytes: DEFAULT_RESERVE_FREE_BYTES - 1 + byteLength,
      emitLog: (_level, event, fields) => events.push({ event, fields }),
    });

    await expect(budget.ensureDownloadBudget([createTarget({ byteLength })])).rejects.toThrow(
      StorageLimitError,
    );
    expect(events).toEqual([
      {
        event: "storage_reserve_violation",
        fields: {
          available_bytes: DEFAULT_RESERVE_FREE_BYTES - 1 + byteLength,
          estimated_download_bytes: byteLength,
          reserve_free_bytes: DEFAULT_RESERVE_FREE_BYTES,
        },
      },
    ]);
  });

  it("passes when free space after the download stays at the default reserve", async () => {
    const root = createRoot();
    const byteLength = 5000;
    const budget = createBudget(root, {
      availableBytes: DEFAULT_RESERVE_FREE_BYTES + byteLength,
    });

    await expect(
      budget.ensureDownloadBudget([createTarget({ byteLength })]),
    ).resolves.toBeUndefined();
  });

  it("discounts partial download bytes when enforcing the reserve", async () => {
    const root = createRoot();
    const target = createTarget({ byteLength: 1000 });
    const partialPath = partialDownloadPath(root, target);
    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(partialPath, "x".repeat(990));
    const budget = createBudget(root, {
      availableBytes: DEFAULT_RESERVE_FREE_BYTES + 10,
    });

    await expect(budget.ensureDownloadBudget([target])).resolves.toBeUndefined();
  });
});

describe("StorageBudget commit-time reserve", () => {
  it("throws when free space is below the reserve at commit time", async () => {
    const root = createRoot();
    const budget = createBudget(root, { availableBytes: DEFAULT_RESERVE_FREE_BYTES - 1 });

    await expect(budget.ensureCommitReserve()).rejects.toThrow(
      `Committing download would violate reserveFreeBytes ${DEFAULT_RESERVE_FREE_BYTES}.`,
    );
  });

  it("allows commit when free space equals the reserve", async () => {
    const root = createRoot();
    const budget = createBudget(root, { availableBytes: DEFAULT_RESERVE_FREE_BYTES });

    await expect(budget.ensureCommitReserve()).resolves.toBeUndefined();
  });

  it("preserves an explicit reserveFreeBytes of zero (no headroom)", async () => {
    const root = createRoot();
    const budget = createBudget(root, { reserveFreeBytes: 0, availableBytes: 0 });

    await expect(budget.ensureCommitReserve()).resolves.toBeUndefined();
  });
});

describe("StorageBudget TOCTOU resilience during on-disk scans", () => {
  it("does not throw from ensureDownloadBudget when a blob vanishes mid-scan", async () => {
    const root = createRoot();
    const vanishingPath = join(root, "blobs", "vanishing", "v1", "gone.bin");
    mkdirSync(dirname(vanishingPath), { recursive: true });
    writeFileSync(vanishingPath, "12345");
    // A second file stays put so the scan still walks the tree after the vanish.
    const stablePath = join(root, "blobs", "stable", "v1", "kept.bin");
    mkdirSync(dirname(stablePath), { recursive: true });
    writeFileSync(stablePath, "abc");

    const budget = createBudget(root, {
      maxCacheBytes: 100,
      reserveFreeBytes: 0,
      disk: vanishingEntryDiskOps(vanishingPath),
    });

    await expect(
      budget.ensureDownloadBudget([createTarget({ byteLength: 1 })]),
    ).resolves.toBeUndefined();
  });

  it("does not throw from ensureDownloadBudget when a directory vanishes between stat and readdir", async () => {
    const root = createRoot();
    const vanishingDir = join(root, "blobs", "vanishing-dir");
    mkdirSync(vanishingDir, { recursive: true });
    writeFileSync(join(vanishingDir, "child.bin"), "12345");

    const budget = createBudget(root, {
      maxCacheBytes: 100,
      reserveFreeBytes: 0,
      disk: {
        readdirSync: (path) => {
          if (path === vanishingDir) {
            rmSync(vanishingDir, { recursive: true, force: true });
          }
          return readdirSync(path);
        },
        statSync: (path, options) => statSync(path, options),
      },
    });

    await expect(
      budget.ensureDownloadBudget([createTarget({ byteLength: 1 })]),
    ).resolves.toBeUndefined();
  });

  it("treats a partial download that vanishes between check and stat as zero bytes", () => {
    const root = createRoot();
    const target = createTarget({ byteLength: 20 });
    const partialPath = partialDownloadPath(root, target);
    mkdirSync(dirname(partialPath), { recursive: true });
    writeFileSync(partialPath, "partial");

    const bytes = partialDownloadBytes(root, target, (path, options) => {
      if (path === partialPath) {
        rmSync(partialPath, { force: true });
      }
      return statSync(path, options);
    });

    expect(bytes).toBe(0);

    const budget = createBudget(root);
    expect(budget.remainingDownloadBytes(target)).toBe(20);
  });
});
