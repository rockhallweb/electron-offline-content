import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, statfsSync, writeFileSync } from "node:fs";
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

function createBudget(
  root: string,
  options?: {
    maxCacheBytes?: number;
    reserveFreeBytes?: number;
    availableBytes?: number;
    emitLog?: StorageBudgetLogHandler;
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
