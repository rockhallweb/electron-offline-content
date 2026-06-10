import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MediaCacheDatabase } from "../../src/main/database.js";
import { GenerationLifecycle } from "../../src/main/generation-lifecycle.js";
import { validateFlatManifest } from "../../src/shared/normalize.js";
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
    db = new MediaCacheDatabase(storageRoot, {
      devPassthrough: false,
      assetBaseUrlOrigin: null,
    });
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
    const manifest = validateFlatManifest(store._serialize());
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

  it("rolls back a staged generation while preserving blobs shared with the committed generation", () => {
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

    expect(existsSync(sharedAbsolutePath)).toBe(true);
    expect(existsSync(stagedOnlyAbsolutePath)).toBe(false);
    expect(existsSync(dirname(stagedOnlyAbsolutePath))).toBe(false);
    expect(db.listStagedGenerationIds()).toEqual([]);
    expect(db.getActiveGenerationId()).toBe(committedGenerationId);
    expect(db.getGenerationAssets(committedGenerationId)).toHaveLength(1);
  });

  it("rolls back all staged blobs when no generation has been committed", () => {
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

    expect(existsSync(stagedAbsolutePath)).toBe(false);
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
    expect(existsSync(sharedAbsolutePath)).toBe(true);
    expect(existsSync(orphanOnlyAbsolutePath)).toBe(false);
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

  it("normalizes windows-style stored paths when matching shared blobs", () => {
    const sharedPath = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
    const windowsSharedPath = sharedPath.split("/").join("\\");

    const committedGenerationId = stageGeneration("committed", [
      {
        key: "nature/forest/main",
        version: "v1",
        mimeType: "video/mp4",
        fileName: "main.mp4",
        url: "https://example.test/main.mp4",
        relativePath: windowsSharedPath,
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
      ],
      2,
    );
    const sharedAbsolutePath = writeBlob(sharedPath, "video-one");

    lifecycle.rollbackStagedGeneration(stagedGenerationId);

    expect(existsSync(sharedAbsolutePath)).toBe(true);
    expect(db.listStagedGenerationIds()).toEqual([]);
  });
});
