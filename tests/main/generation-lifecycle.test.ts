import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { hashKey } from "../../src/internal/asset-key.js";
import { MediaCacheDatabase } from "../../src/main/database.js";
import { GenerationLifecycle } from "../../src/main/generation-lifecycle.js";
import { validateFlatManifest } from "../../src/shared/normalize.js";
import { buildTestStore } from "./helpers/media-cache-test-shared.js";

describe("GenerationLifecycle", () => {
  it("rolls back staged generation files without deleting blobs reused by the active generation", () => {
    const root = mkdtempSync(join(tmpdir(), "generation-lifecycle-rollback-"));
    try {
      const db = createDatabase(root);
      const activeGenerationId = stageGeneration(db, {
        snapshotId: "active",
        assets: [
          {
            key: "nature/forest/main",
            version: "v1",
            mimeType: "video/mp4",
            fileName: "main.mp4",
            url: "https://example.test/main.mp4",
          },
        ],
      });
      const reusedPath = blobPathFor(hashKey("nature/forest/main"), "v1", "main.mp4");
      db.setAssetDownloadState(
        activeGenerationId,
        hashKey("nature/forest/main"),
        reusedPath,
        "video/mp4",
      );
      writeBlob(root, reusedPath, "active");
      db.activateGeneration(activeGenerationId, 2);

      const stagedGenerationId = stageGeneration(db, {
        snapshotId: "staged",
        assets: [
          {
            key: "nature/forest/main",
            version: "v1",
            mimeType: "video/mp4",
            fileName: "main.mp4",
            url: "https://example.test/main.mp4",
          },
          {
            key: "nature/forest/poster",
            version: "v2",
            mimeType: "image/jpeg",
            fileName: "poster.jpg",
            url: "https://example.test/poster.jpg",
          },
        ],
      });
      const stagedOnlyPath = blobPathFor(hashKey("nature/forest/poster"), "v2", "poster.jpg");
      db.setAssetDownloadState(
        stagedGenerationId,
        hashKey("nature/forest/main"),
        reusedPath,
        "video/mp4",
      );
      db.setAssetDownloadState(
        stagedGenerationId,
        hashKey("nature/forest/poster"),
        stagedOnlyPath,
        "image/jpeg",
      );
      writeBlob(root, stagedOnlyPath, "staged");

      new GenerationLifecycle(root, db).rollbackStagedGeneration(stagedGenerationId);

      expect(db.listStagedGenerationIds()).toEqual([]);
      expect(db.getActiveGenerationId()).toBe(activeGenerationId);
      expect(existsSync(join(root, reusedPath))).toBe(true);
      expect(existsSync(join(root, stagedOnlyPath))).toBe(false);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles orphaned staged generations through one lifecycle interface", () => {
    const root = mkdtempSync(join(tmpdir(), "generation-lifecycle-orphan-"));
    try {
      const db = createDatabase(root);
      const activeGenerationId = stageGeneration(db, {
        snapshotId: "active",
        assets: [
          {
            key: "nature/forest/main",
            version: "v1",
            mimeType: "video/mp4",
            fileName: "main.mp4",
            url: "https://example.test/main.mp4",
          },
        ],
      });
      db.activateGeneration(activeGenerationId, 2);

      const orphanedGenerationId = stageGeneration(db, {
        snapshotId: "orphan",
        assets: [
          {
            key: "nature/forest/poster",
            version: "v2",
            mimeType: "image/jpeg",
            fileName: "poster.jpg",
            url: "https://example.test/poster.jpg",
          },
        ],
      });
      const orphanedPath = blobPathFor(hashKey("nature/forest/poster"), "v2", "poster.jpg");
      db.setAssetDownloadState(
        orphanedGenerationId,
        hashKey("nature/forest/poster"),
        orphanedPath,
        "image/jpeg",
      );
      writeBlob(root, orphanedPath, "orphan");

      const result = new GenerationLifecycle(root, db).reconcileOrphanedStagedGenerations();

      expect(result).toEqual({
        activeGenerationId,
        removedGenerationIds: [orphanedGenerationId],
      });
      expect(db.listStagedGenerationIds()).toEqual([]);
      expect(existsSync(join(root, orphanedPath))).toBe(false);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createDatabase(root: string): MediaCacheDatabase {
  return new MediaCacheDatabase(root, {
    devPassthrough: false,
    assetBaseUrlOrigin: null,
  });
}

function stageGeneration(
  db: MediaCacheDatabase,
  input: Parameters<typeof buildTestStore>[0],
): number {
  const manifest = validateFlatManifest(buildTestStore(input)._serialize());
  return db.createStagedGeneration(manifest, 1);
}

function blobPathFor(assetKey: string, version: string, fileName: string): string {
  return join("blobs", assetKey, version, fileName);
}

function writeBlob(root: string, relativePath: string, contents: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}
