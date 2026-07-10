import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MediaCacheDatabase } from "../../src/main/database.js";
import {
  DEFAULT_STALE_DELETE_MS,
  GenerationLifecycle,
  normalizeStoredRelativePath,
  pruneEmptyParents,
} from "../../src/main/generation-lifecycle.js";
import { normalizeManifest } from "../../src/shared/normalize.js";
import type { MediaCacheLogLevel } from "../../src/shared/types.js";
import {
  blobPathFor,
  buildTestStore,
  createStorageRoot,
  hashKey,
  type TestAsset,
} from "./helpers/media-cache-test-shared.js";

interface CapturedLog {
  level: MediaCacheLogLevel;
  event: string;
  fields: Record<string, unknown>;
}

describe("generation lifecycle", () => {
  let storageRoot: string;
  let db: MediaCacheDatabase;
  let logs: CapturedLog[];
  let lifecycle: GenerationLifecycle;

  beforeEach(() => {
    storageRoot = createStorageRoot();
    mkdirSync(join(storageRoot, "blobs"), { recursive: true });
    db = new MediaCacheDatabase(storageRoot);
    logs = [];
    lifecycle = new GenerationLifecycle(storageRoot, db, {
      emitLog: (level, event, fields = {}) => {
        logs.push({ level, event, fields });
      },
    });
  });

  function stageGeneration(
    snapshotId: string,
    assets: Array<TestAsset & { relativePath?: string }>,
    now = 1,
  ): number {
    const store = buildTestStore({
      snapshotId,
      assets,
    });
    const manifest = normalizeManifest(store._serialize());
    const generationId = db.createStagedGeneration(manifest, now);
    for (const asset of assets) {
      if (asset.relativePath) {
        db.setAssetDownloadState(generationId, hashKey(asset.key), asset.relativePath, null);
      }
    }
    return generationId;
  }

  function writeBlob(relativePath: string, contents: string): string {
    const absolutePath = join(storageRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
    return absolutePath;
  }

  it("rolls back a staged generation while preserving every completed blob on disk", () => {
    const sharedPath = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
    const stagedOnlyPath = blobPathFor(hashKey("nature/forest/poster"), "v2", "poster-v2.jpg");

    const committedGenerationId = stageGeneration("committed", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: sharedPath,
      },
    ]);
    db.activateGeneration(committedGenerationId, 1);

    const stagedGenerationId = stageGeneration(
      "staged",
      [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "main.mp4",
          url: "https://example.test/main.mp4",
          relativePath: sharedPath,
        },
        {
          key: "nature/forest/poster",
          version: "v2",
          mimeType: "image/jpeg",
          fileName: "poster-v2.jpg",
          url: "https://example.test/poster-v2.jpg",
          relativePath: stagedOnlyPath,
        },
      ],
      2,
    );
    const sharedAbsolutePath = writeBlob(sharedPath, "video-one");
    const stagedOnlyAbsolutePath = writeBlob(stagedOnlyPath, "poster-v2");

    lifecycle.rollbackStagedGeneration(stagedGenerationId);

    // Both the shared blob and the staged-only blob survive: a file at the blob path is a
    // complete copy of exactly that asset version, so the next sync can adopt it.
    expect(existsSync(sharedAbsolutePath)).toBe(true);
    expect(existsSync(stagedOnlyAbsolutePath)).toBe(true);
    expect(db.listStagedGenerationIds()).toEqual([]);
    expect(db.getActiveGenerationId()).toBe(committedGenerationId);
    expect(db.getGenerationAssets(committedGenerationId)).toHaveLength(1);
  });

  it("preserves completed blobs on rollback when no generation has ever been committed", () => {
    const stagedPath = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
    const stagedGenerationId = stageGeneration("first-sync", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: stagedPath,
      },
    ]);
    const stagedAbsolutePath = writeBlob(stagedPath, "video-one");

    lifecycle.rollbackStagedGeneration(stagedGenerationId);

    // Regression guard: a failed first-ever sync must not delete its completed downloads, or a
    // large initial sync over a flaky connection could never make forward progress on retry.
    expect(existsSync(stagedAbsolutePath)).toBe(true);
    expect(db.listStagedGenerationIds()).toEqual([]);
    expect(db.getActiveGenerationId()).toBeNull();
  });

  it("skips staged assets without a relative path during rollback", () => {
    const stagedGenerationId = stageGeneration("never-downloaded", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
      },
    ]);

    expect(() => lifecycle.rollbackStagedGeneration(stagedGenerationId)).not.toThrow();
    expect(db.listStagedGenerationIds()).toEqual([]);
  });

  it("reconciles orphaned staged generations and preserves the committed snapshot", () => {
    const sharedPath = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
    const orphanOnlyPath = blobPathFor(hashKey("nature/forest/poster"), "v2", "poster-v2.jpg");

    const committedGenerationId = stageGeneration("committed", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: sharedPath,
      },
    ]);
    db.activateGeneration(committedGenerationId, 1);

    const orphanedGenerationId = stageGeneration(
      "orphaned-stage",
      [
        {
          key: "nature/forest/main",
          version: "v1",
          mimeType: "video/mp4",
          fileName: "main.mp4",
          url: "https://example.test/main.mp4",
          relativePath: sharedPath,
        },
        {
          key: "nature/forest/poster",
          version: "v2",
          mimeType: "image/jpeg",
          fileName: "poster-v2.jpg",
          url: "https://example.test/poster-v2.jpg",
          relativePath: orphanOnlyPath,
        },
      ],
      2,
    );
    const sharedAbsolutePath = writeBlob(sharedPath, "video-one");
    const orphanOnlyAbsolutePath = writeBlob(orphanOnlyPath, "orphaned-poster");

    const activeGenerationId = lifecycle.reconcileOrphanedStagedGenerations();

    expect(activeGenerationId).toBe(committedGenerationId);
    // Only the orphaned rows are removed; both blobs stay on disk for the next sync to adopt.
    expect(existsSync(sharedAbsolutePath)).toBe(true);
    expect(existsSync(orphanOnlyAbsolutePath)).toBe(true);
    expect(db.listStagedGenerationIds()).toEqual([]);
    expect(db.getGenerationAssets(orphanedGenerationId)).toEqual([]);
    expect(logs).toEqual([
      {
        level: "warn",
        event: "orphaned_staged_generations_removed",
        fields: {
          active_generation_id: committedGenerationId,
          removed_generation_ids: [orphanedGenerationId],
          removed_generation_count: 1,
        },
      },
    ]);
  });

  it("returns the active generation id without logging when no orphans exist", () => {
    const committedPath = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
    const committedGenerationId = stageGeneration("committed", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: committedPath,
      },
    ]);
    db.activateGeneration(committedGenerationId, 1);
    const committedAbsolutePath = writeBlob(committedPath, "video-one");

    expect(lifecycle.reconcileOrphanedStagedGenerations()).toBe(committedGenerationId);
    expect(existsSync(committedAbsolutePath)).toBe(true);
    expect(logs).toEqual([]);
  });

  it("returns null when no generation exists at all", () => {
    expect(lifecycle.reconcileOrphanedStagedGenerations()).toBeNull();
    expect(logs).toEqual([]);
  });

  it("refuses to delete pending-deletion paths that escape the storage root", () => {
    const escapingRelativePath = "../escape-target.bin";
    const assetKey = hashKey("nature/forest/main");
    db.markPendingDeletion(
      assetKey,
      escapingRelativePath,
      99,
      JSON.stringify([assetKey, escapingRelativePath]),
      50,
    );
    const outsideAbsolutePath = writeBlob(escapingRelativePath, "outside-cache");

    try {
      lifecycle.pruneExpiredDeletions(100);

      // The escaping path is skipped (never deleted) but its record is still cleared.
      expect(existsSync(outsideAbsolutePath)).toBe(true);
      expect(db.getExpiredPendingDeletions(Number.MAX_SAFE_INTEGER)).toEqual([]);
      expect(logs).toContainEqual({
        level: "warn",
        event: "pending_deletion_path_outside_storage_root",
        fields: { relative_path: escapingRelativePath },
      });
    } finally {
      rmSync(outsideAbsolutePath, { force: true });
    }
  });

  it("normalizes windows-style stored paths so blob matching is platform-independent", () => {
    // Adoption, collectReferencedBlobPaths, and pruneUnreferencedBlobs all compare stored paths
    // through this helper; a backslash-separated path persisted on Windows must match the
    // forward-slash paths derived from the manifest, or a matching blob would be wrongly pruned.
    expect(normalizeStoredRelativePath("blobs\\abc\\v1\\main.mp4")).toBe("blobs/abc/v1/main.mp4");
    expect(normalizeStoredRelativePath("blobs/abc/v1/main.mp4")).toBe("blobs/abc/v1/main.mp4");
  });

  it("does not prune sibling directories whose name shares the storage root as a prefix", () => {
    const siblingRoot = `${storageRoot}2`;
    const siblingDirectory = join(siblingRoot, "empty");
    mkdirSync(siblingDirectory, { recursive: true });

    try {
      pruneEmptyParents(join(siblingDirectory, "missing.bin"), storageRoot);

      expect(existsSync(siblingDirectory)).toBe(true);
    } finally {
      rmSync(siblingRoot, { recursive: true, force: true });
    }
  });

  it("commits a staged generation and marks replaced blob paths for delayed deletion", () => {
    const staleDeleteAfterMs = 1_000;
    const delayedLifecycle = new GenerationLifecycle(storageRoot, db, {
      staleDeleteAfterMs,
      emitLog: (level, event, fields = {}) => {
        logs.push({ level, event, fields });
      },
    });
    const v1Path = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
    const posterPath = blobPathFor(hashKey("nature/forest/poster"), "v1", "poster.jpg");
    const v2Path = blobPathFor(hashKey("nature/forest/main"), "v2", "main-v2.mp4");

    const committedGenerationId = stageGeneration("committed", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: v1Path,
      },
      {
        key: "nature/forest/poster",
        version: "v1",
        mimeType: "image/jpeg",
        fileName: "poster.jpg",
        url: "https://example.test/poster.jpg",
        relativePath: posterPath,
      },
    ]);
    db.activateGeneration(committedGenerationId, 1);

    const stagedGenerationId = stageGeneration(
      "staged",
      [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "main-v2.mp4",
          url: "https://example.test/main-v2.mp4",
          relativePath: v2Path,
        },
        {
          key: "nature/forest/poster",
          version: "v1",
          mimeType: "image/jpeg",
          fileName: "poster.jpg",
          url: "https://example.test/poster.jpg",
          relativePath: posterPath,
        },
      ],
      2,
    );
    const v1AbsolutePath = writeBlob(v1Path, "video-one");
    writeBlob(posterPath, "poster");
    writeBlob(v2Path, "video-two");

    const now = 100;
    const { previousGenerationId } = delayedLifecycle.commitStagedGeneration(
      stagedGenerationId,
      now,
    );

    expect(previousGenerationId).toBe(committedGenerationId);
    expect(db.getActiveGenerationId()).toBe(stagedGenerationId);
    expect(existsSync(v1AbsolutePath)).toBe(true);
    expect(db.getExpiredPendingDeletions(now + staleDeleteAfterMs - 1)).toEqual([]);
    expect(db.getExpiredPendingDeletions(now + staleDeleteAfterMs)).toMatchObject([
      { relativePath: v1Path },
    ]);
    expect(logs).toEqual([
      {
        level: "debug",
        event: "assets_marked_for_deletion",
        fields: {
          previous_generation_id: committedGenerationId,
          active_generation_id: stagedGenerationId,
          marked_count: 1,
          delete_after_ms: now + staleDeleteAfterMs,
        },
      },
    ]);
  });

  it("does not mark a blob as replaced when stored path separators differ", () => {
    const assetKey = hashKey("nature/forest/main");
    const canonicalPath = blobPathFor(assetKey, "v1", "main.mp4");
    const windowsPath = canonicalPath.replaceAll("/", "\\");
    const committedGenerationId = stageGeneration("legacy-windows", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: windowsPath,
      },
    ]);
    db.activateGeneration(committedGenerationId, 1);
    const stagedGenerationId = stageGeneration("canonical", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: canonicalPath,
      },
    ]);
    writeBlob(canonicalPath, "video-one");

    lifecycle.commitStagedGeneration(stagedGenerationId, 100);

    expect(db.getExpiredPendingDeletions(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(logs.at(-1)).toMatchObject({
      event: "assets_marked_for_deletion",
      fields: { marked_count: 0 },
    });
  });

  it("returns null and marks nothing on the first commit", () => {
    const stagedPath = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
    const stagedGenerationId = stageGeneration("first-commit", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: stagedPath,
      },
    ]);
    writeBlob(stagedPath, "video-one");

    const { previousGenerationId } = lifecycle.commitStagedGeneration(stagedGenerationId, 100);

    expect(previousGenerationId).toBeNull();
    expect(db.getActiveGenerationId()).toBe(stagedGenerationId);
    expect(db.getExpiredPendingDeletions(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("clears pending deletions for blob paths the committed generation references again", () => {
    const v1Path = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
    db.markPendingDeletion(
      hashKey("nature/forest/main"),
      v1Path,
      99,
      JSON.stringify([hashKey("nature/forest/main"), v1Path]),
      50,
    );
    expect(db.getExpiredPendingDeletions(Number.MAX_SAFE_INTEGER)).toHaveLength(1);

    const stagedGenerationId = stageGeneration("resurrects-v1", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: v1Path,
      },
    ]);
    writeBlob(v1Path, "video-one");

    lifecycle.commitStagedGeneration(stagedGenerationId, 100);

    expect(db.getExpiredPendingDeletions(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("applies the default stale delete delay when staleDeleteAfterMs is omitted", () => {
    const v1Path = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
    const v2Path = blobPathFor(hashKey("nature/forest/main"), "v2", "main-v2.mp4");
    const committedGenerationId = stageGeneration("committed", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: v1Path,
      },
    ]);
    db.activateGeneration(committedGenerationId, 1);
    const stagedGenerationId = stageGeneration(
      "staged",
      [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "main-v2.mp4",
          url: "https://example.test/main-v2.mp4",
          relativePath: v2Path,
        },
      ],
      2,
    );

    const now = 100;
    lifecycle.commitStagedGeneration(stagedGenerationId, now);

    expect(db.getExpiredPendingDeletions(now + DEFAULT_STALE_DELETE_MS - 1)).toEqual([]);
    expect(db.getExpiredPendingDeletions(now + DEFAULT_STALE_DELETE_MS)).toMatchObject([
      { relativePath: v1Path },
    ]);
  });

  it("prunes expired pending deletions, removing blob files and their records", () => {
    const staleDeleteAfterMs = 1_000;
    const delayedLifecycle = new GenerationLifecycle(storageRoot, db, {
      staleDeleteAfterMs,
      emitLog: (level, event, fields = {}) => {
        logs.push({ level, event, fields });
      },
    });
    const v1Path = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
    const v2Path = blobPathFor(hashKey("nature/forest/main"), "v2", "main-v2.mp4");
    const committedGenerationId = stageGeneration("committed", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: v1Path,
      },
    ]);
    db.activateGeneration(committedGenerationId, 1);
    const stagedGenerationId = stageGeneration(
      "staged",
      [
        {
          key: "nature/forest/main",
          version: "v2",
          mimeType: "video/mp4",
          fileName: "main-v2.mp4",
          url: "https://example.test/main-v2.mp4",
          relativePath: v2Path,
        },
      ],
      2,
    );
    const v1AbsolutePath = writeBlob(v1Path, "video-one");
    const v2AbsolutePath = writeBlob(v2Path, "video-two");

    delayedLifecycle.commitStagedGeneration(stagedGenerationId, 100);

    delayedLifecycle.pruneExpiredDeletions(100 + staleDeleteAfterMs - 1);
    expect(existsSync(v1AbsolutePath)).toBe(true);
    expect(logs.at(-1)).toEqual({
      level: "debug",
      event: "deletion_prune_skipped",
      fields: { expired_count: 0 },
    });

    delayedLifecycle.pruneExpiredDeletions(100 + staleDeleteAfterMs);
    expect(existsSync(v1AbsolutePath)).toBe(false);
    expect(existsSync(dirname(v1AbsolutePath))).toBe(false);
    expect(existsSync(v2AbsolutePath)).toBe(true);
    expect(db.getExpiredPendingDeletions(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(logs.at(-1)).toEqual({
      level: "debug",
      event: "assets_pruned",
      fields: { pruned_count: 1 },
    });
  });

  it("cancels an expired deletion when the active generation still references the blob", () => {
    const assetKey = hashKey("nature/forest/main");
    const canonicalPath = blobPathFor(assetKey, "v1", "main.mp4");
    const windowsPath = canonicalPath.replaceAll("/", "\\");
    const activeGenerationId = stageGeneration("active", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: canonicalPath,
      },
    ]);
    db.activateGeneration(activeGenerationId, 1);
    const activeBlobPath = writeBlob(canonicalPath, "video-one");
    db.markPendingDeletion(assetKey, windowsPath, 99, JSON.stringify([assetKey, windowsPath]), 50);

    lifecycle.pruneExpiredDeletions(100);

    expect(existsSync(activeBlobPath)).toBe(true);
    expect(db.getExpiredPendingDeletions(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});
