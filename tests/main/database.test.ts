import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaCacheDatabase } from "../../src/main/database.js";

describe("MediaCacheDatabase", () => {
  it("creates all tables with correct schema on first init", () => {
    const root = mkdtempSync(join(tmpdir(), "media-cache-init-test-"));
    try {
      const db = new MediaCacheDatabase(root, {
        devPassthrough: false,
        assetBaseUrlOrigin: null,
      });

      // Verify sync_runs table works
      const id = db.createSyncRun(1000);
      db.completeSyncRun(id, "success", 1001, {
        totalAssets: 0,
        downloadedAssets: 0,
        skippedAssets: 0,
        bytesDownloaded: 0,
      });
      expect(db.getSyncRun(id)).not.toBeNull();

      // Verify key tables and columns exist via PRAGMA
      const dbInternal = (
        db as unknown as {
          db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } };
        }
      ).db;
      const expectedTables = ["generations", "assets", "sync_runs", "pending_deletions"];
      for (const table of expectedTables) {
        const columns = dbInternal.prepare(`PRAGMA table_info(${table})`).all();
        expect(columns.length).toBeGreaterThan(0);
      }
      const assetColumns = dbInternal.prepare("PRAGMA table_info(assets)").all();
      expect(assetColumns.map((c) => c.name)).toContain("source_json");
      expect(assetColumns.map((c) => c.name)).toContain("resolved_request_json");

      const pendingColumns = dbInternal.prepare("PRAGMA table_info(pending_deletions)").all();
      expect(pendingColumns.map((c) => c.name)).toContain("deletion_key");

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
      const db = new MediaCacheDatabase(root, {
        devPassthrough: false,
        assetBaseUrlOrigin: null,
      });

      const runIds: number[] = [];
      for (let i = 1; i <= 5; i++) {
        const id = db.createSyncRun(i * 1000);
        runIds.push(id);
        db.completeSyncRun(id, "success", i * 1000 + 1, emptyStats());
      }

      db.pruneSyncHistory(2);

      // Runs 4 and 5 (most recent) should remain; runs 1, 2, 3 should be deleted
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
      const db = new MediaCacheDatabase(root, {
        devPassthrough: false,
        assetBaseUrlOrigin: null,
      });

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
      const db = new MediaCacheDatabase(root, {
        devPassthrough: false,
        assetBaseUrlOrigin: null,
      });

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
      const db = new MediaCacheDatabase(root, {
        devPassthrough: false,
        assetBaseUrlOrigin: null,
      });
      db.close();

      expect(() => db.loadStatus()).toThrow("MediaCacheDatabase is closed");
      expect(() => db.createSyncRun(1000)).toThrow("MediaCacheDatabase is closed");
      expect(() => db.getActiveGenerationId()).toThrow("MediaCacheDatabase is closed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
