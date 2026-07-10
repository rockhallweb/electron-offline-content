import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashKey } from "../../src/internal/asset-key.js";
import { DataValidationError } from "../../src/shared/errors.js";
import { MediaCacheDatabase } from "../../src/main/database.js";
import { createMediaStore } from "../../src/main/store.js";
import { normalizeManifest } from "../../src/shared/normalize.js";

describe("MediaCacheDatabase", () => {
  it("creates all tables with correct schema on first init", () => {
    const root = mkdtempSync(join(tmpdir(), "media-cache-init-test-"));
    try {
      const db = new MediaCacheDatabase(root);

      const id = db.createSyncRun(1000);
      db.completeSyncRun(id, "success", 1001, {
        totalAssets: 0,
        downloadedAssets: 0,
        skippedAssets: 0,
        bytesDownloaded: 0,
      });
      expect(db.getSyncRun(id)).not.toBeNull();

      const dbInternal = (
        db as unknown as {
          db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } };
        }
      ).db;
      const expectedTables = [
        "generations",
        "assets",
        "asset_indexes",
        "index_definitions",
        "sync_runs",
        "pending_deletions",
      ];
      for (const table of expectedTables) {
        const columns = dbInternal.prepare(`PRAGMA table_info(${table})`).all();
        expect(columns.length).toBeGreaterThan(0);
      }
      const assetColumns = dbInternal.prepare("PRAGMA table_info(assets)").all();
      expect(assetColumns.map((c) => c.name)).toContain("asset_key");
      expect(assetColumns.map((c) => c.name)).toContain("url");
      expect(assetColumns.map((c) => c.name)).toContain("indexes_json");
      expect(assetColumns.map((c) => c.name)).toContain("media_kind");
      expect(assetColumns.map((c) => c.name)).toContain("file_stem");

      const pendingColumns = dbInternal.prepare("PRAGMA table_info(pending_deletions)").all();
      expect(pendingColumns.map((c) => c.name)).toContain("deletion_key");
      expect(pendingColumns.map((c) => c.name)).toContain("asset_key");

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("listByIndex matches each value of a multi-cardinality index via flattened rows", () => {
    const root = mkdtempSync(join(tmpdir(), "media-cache-multi-idx-"));
    try {
      const db = new MediaCacheDatabase(root);

      const store = createMediaStore();
      const tags = store.defineIndex("tags", { cardinality: "multi" });
      store.add(["a", "v", "1"], {
        version: "v1",
        mimeType: "video/mp4",
        url: "https://example.com/v.mp4",
        indexes: [tags(["forest", "ambient"])],
      });
      const manifest = normalizeManifest(store._serialize());
      const genId = db.createStagedGeneration(manifest, 1);
      db.activateGeneration(genId, 2);

      const forest = db.listRowsByIndex("tags", "forest");
      expect(forest.items).toHaveLength(1);
      expect(forest.items[0]?.displayKey).toBe("a/v/1");

      const ambient = db.listRowsByIndex("tags", "ambient");
      expect(ambient.items).toHaveLength(1);
      expect(ambient.items[0]?.assetKey).toBe(hashKey(["a", "v", "1"]));
      expect(ambient.items[0]?.assetKey).toBe(forest.items[0]?.assetKey);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("getAssetRow returns a validated row and rejects corrupted rows", () => {
    const root = mkdtempSync(join(tmpdir(), "media-cache-row-validation-"));
    try {
      const db = new MediaCacheDatabase(root);

      const store = createMediaStore();
      store.add(["a", "v", "1"], {
        version: "v1",
        mimeType: "video/mp4",
        url: "https://example.com/v.mp4",
      });
      const manifest = normalizeManifest(store._serialize());
      const genId = db.createStagedGeneration(manifest, 1);
      db.activateGeneration(genId, 2);

      const assetKey = hashKey(["a", "v", "1"]);
      const row = db.getAssetRow(assetKey);
      expect(row).not.toBeNull();
      expect(row?.assetKey).toBe(assetKey);
      expect(row?.displayKey).toBe("a/v/1");
      expect(row?.url).toBe("https://example.com/v.mp4");

      const dbInternal = (
        db as unknown as {
          db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
        }
      ).db;
      dbInternal
        .prepare("UPDATE assets SET media_kind = 'not-a-media-kind' WHERE asset_key = ?")
        .run(assetKey);

      expect(() => db.getAssetRow(assetKey)).toThrow(DataValidationError);

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes legacy windows stored paths when reopening the database", () => {
    const root = mkdtempSync(join(tmpdir(), "media-cache-path-migration-"));
    try {
      const db = new MediaCacheDatabase(root);
      const store = createMediaStore();
      store.add(["a", "v", "1"], {
        version: "v1",
        mimeType: "video/mp4",
        url: "https://example.com/v.mp4",
      });
      const generationId = db.createStagedGeneration(normalizeManifest(store._serialize()), 1);
      const assetKey = hashKey(["a", "v", "1"]);
      const canonicalPath = `blobs/${assetKey}/v1/v.mp4`;
      const windowsPath = canonicalPath.replaceAll("/", "\\");
      db.setAssetRelativePath(generationId, assetKey, canonicalPath);
      db.markPendingDeletion(
        assetKey,
        canonicalPath,
        generationId,
        JSON.stringify([assetKey, canonicalPath]),
        100,
      );

      const dbInternal = (
        db as unknown as {
          db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
        }
      ).db;
      dbInternal
        .prepare("UPDATE assets SET relative_path = ? WHERE generation_id = ? AND asset_key = ?")
        .run(windowsPath, generationId, assetKey);
      dbInternal
        .prepare("UPDATE pending_deletions SET relative_path = ? WHERE asset_key = ?")
        .run(windowsPath, assetKey);
      db.close();

      const reopened = new MediaCacheDatabase(root);
      expect(reopened.getGenerationAssets(generationId)[0]?.relativePath).toBe(canonicalPath);
      expect(reopened.getPendingDeletionRelativePaths()).toEqual([canonicalPath]);
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists newly written stored paths with canonical separators", () => {
    const root = mkdtempSync(join(tmpdir(), "media-cache-canonical-paths-"));
    try {
      const db = new MediaCacheDatabase(root);
      const store = createMediaStore();
      store.add(["a", "v", "1"], {
        version: "v1",
        mimeType: "video/mp4",
        url: "https://example.com/v.mp4",
      });
      const generationId = db.createStagedGeneration(normalizeManifest(store._serialize()), 1);
      const assetKey = hashKey(["a", "v", "1"]);
      const canonicalPath = `blobs/${assetKey}/v1/v.mp4`;
      const windowsPath = canonicalPath.replaceAll("/", "\\");

      db.setAssetDownloadState(generationId, assetKey, windowsPath, null);
      db.markPendingDeletion(
        assetKey,
        windowsPath,
        generationId,
        JSON.stringify([assetKey, canonicalPath]),
        100,
      );

      expect(db.getGenerationAssets(generationId)[0]?.relativePath).toBe(canonicalPath);
      expect(db.getPendingDeletionRelativePaths()).toEqual([canonicalPath]);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pruneSyncHistory", () => {
  const emptyStats = () => ({
    totalAssets: 0,
    downloadedAssets: 0,
    skippedAssets: 0,
    bytesDownloaded: 0,
  });

  it("keeps the most recent N sync runs and deletes the rest", () => {
    const root = mkdtempSync(join(tmpdir(), "media-cache-prune-test-"));
    try {
      const db = new MediaCacheDatabase(root);

      const runIds: number[] = [];
      for (let i = 1; i <= 5; i++) {
        const id = db.createSyncRun(i * 1000);
        runIds.push(id);
        db.completeSyncRun(id, "success", i * 1000 + 1, emptyStats());
      }

      db.pruneSyncHistory(2);

      expect(db.getSyncRun(runIds[0])).toBeNull();
      expect(db.getSyncRun(runIds[1])).toBeNull();
      expect(db.getSyncRun(runIds[2])).toBeNull();
      expect(db.getSyncRun(runIds[3])).not.toBeNull();
      expect(db.getSyncRun(runIds[4])).not.toBeNull();

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is a no-op when limit is less than 1", () => {
    const root = mkdtempSync(join(tmpdir(), "media-cache-prune-test-"));
    try {
      const db = new MediaCacheDatabase(root);

      const id = db.createSyncRun(1000);
      db.completeSyncRun(id, "success", 1001, emptyStats());

      db.pruneSyncHistory(0);
      expect(db.getSyncRun(id)).not.toBeNull();

      db.pruneSyncHistory(-1);
      expect(db.getSyncRun(id)).not.toBeNull();

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("MediaCacheDatabase.close", () => {
  it("is idempotent and safe to call multiple times", () => {
    const root = mkdtempSync(join(tmpdir(), "media-cache-close-test-"));
    try {
      const db = new MediaCacheDatabase(root);

      expect(() => {
        db.close();
        db.close();
        db.close();
      }).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when methods are called after close", () => {
    const root = mkdtempSync(join(tmpdir(), "media-cache-close-test-"));
    try {
      const db = new MediaCacheDatabase(root);
      db.close();

      expect(() => db.loadStatus()).toThrow("MediaCacheDatabase is closed");
      expect(() => db.createSyncRun(1000)).toThrow("MediaCacheDatabase is closed");
      expect(() => db.getActiveGenerationId()).toThrow("MediaCacheDatabase is closed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
