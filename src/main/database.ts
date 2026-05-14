import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { paginateArray, resolvePaginationWindow } from "../shared/pagination.js";
import type {
  FileStemMatch,
  FlatManifest,
  MediaCacheStatus,
  MediaKind,
  PaginationInput,
  PaginationResult,
  ResolvedMediaAsset,
  SyncRunStats,
  SyncRunSummary,
} from "../shared/types.js";
import {
  activeAssetRowSchema,
  activeGenerationRowSchema,
  generationAssetRowSchema,
  generationIdRowSchema,
  jsonObjectSchema,
  mediaCacheStatusSchema,
  parseJsonWithSchema,
  parseWithSchema,
  pendingDeletionSchema,
  protocolAssetTargetRowSchema,
  statusSnapshotRowSchema,
  stringifyWithSchema,
  syncRunIdRowSchema,
  syncRunRowSchema,
  syncRunStatsSchema,
} from "../internal/validation.js";

const require = createRequire(process.execPath);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface ActiveAssetRow {
  generationId: number;
  assetKey: string;
  displayKey: string;
  version: string;
  mimeType: string;
  mediaKind: MediaKind;
  byteLength: number | null;
  metadata: string;
  indexesJson: string;
  relativePath: string | null;
  url: string;
  fileStem: string;
  orderIndex: number;
}

export interface GenerationAssetRow {
  assetKey: string;
  version: string;
  relativePath: string | null;
  mimeType: string;
  url: string;
}

export interface PendingDeletion {
  deletionKey: string;
  logicalKey: string;
  relativePath: string;
}

export interface ProtocolAssetTarget {
  absolutePath: string | null;
}

export class MediaCacheDatabase {
  private readonly db: import("node:sqlite").DatabaseSync;
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly options: {
      devPassthrough: boolean;
      assetBaseUrlOrigin: string | null;
      /**
       * Invoked only when dev passthrough origin override fails (fallback to stored URL).
       * Not called for invalid `url` (parse error) — those throw.
       */
      onWarn?: (contextLabel: string, err: unknown) => void;
    },
  ) {
    const sqliteDir = join(root, "sqlite");
    mkdirSync(sqliteDir, { recursive: true });
    this.db = new DatabaseSync(join(sqliteDir, "media-cache.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new Error("MediaCacheDatabase is closed");
    }
  }

  /** @internal Used only by prepareDevRuntimeState in dev passthrough startup. */
  clearAllState(): void {
    this.assertNotClosed();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM pending_deletions`).run();
      this.db.prepare(`DELETE FROM asset_indexes`).run();
      this.db.prepare(`DELETE FROM assets`).run();
      this.db.prepare(`DELETE FROM index_definitions`).run();
      this.db.prepare(`DELETE FROM generations`).run();
      this.db.prepare(`DELETE FROM sync_runs`).run();
      this.db.prepare(`DELETE FROM status_snapshot`).run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  loadStatus(): MediaCacheStatus | null {
    this.assertNotClosed();
    const row = this.db
      .prepare(
        `SELECT status_json
         FROM status_snapshot
         WHERE scope_type = 'global' AND scope_key = '*'`,
      )
      .get();
    if (!row) {
      return null;
    }

    const validatedRow = parseWithSchema(statusSnapshotRowSchema, row, "status snapshot row");
    return parseJsonWithSchema(
      validatedRow.status_json,
      mediaCacheStatusSchema,
      "persisted media cache status",
    );
  }

  saveStatus(status: MediaCacheStatus, now: number): void {
    this.assertNotClosed();
    const statusJson = stringifyWithSchema(status, mediaCacheStatusSchema, "media cache status");
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `DELETE FROM status_snapshot
           WHERE scope_type = 'global' AND scope_key = '*'`,
        )
        .run();
      this.db
        .prepare(
          `INSERT INTO status_snapshot (scope_type, scope_key, status_json, updated_at_ms)
           VALUES ('global', '*', ?, ?)`,
        )
        .run(statusJson, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createSyncRun(now: number): number {
    this.assertNotClosed();
    const statsJson = stringifyWithSchema(emptyStats(), syncRunStatsSchema, "sync run stats");
    const result = this.db
      .prepare(
        `INSERT INTO sync_runs (started_at_ms, status, stats_json)
         VALUES (?, 'running', ?)`,
      )
      .run(now, statsJson);
    return Number(result.lastInsertRowid);
  }

  completeSyncRun(
    id: number,
    status: "success" | "error",
    now: number,
    stats: SyncRunStats,
    errorCode: string | null = null,
    errorMessage: string | null = null,
  ): SyncRunSummary {
    this.assertNotClosed();
    const statsJson = stringifyWithSchema(stats, syncRunStatsSchema, "sync run stats");
    this.db
      .prepare(
        `UPDATE sync_runs
         SET finished_at_ms = ?, status = ?, error_code = ?, error_message = ?, stats_json = ?
         WHERE id = ?`,
      )
      .run(now, status, errorCode, errorMessage, statsJson, id);

    return this.getSyncRun(id)!;
  }

  getSyncRun(id: number): SyncRunSummary | null {
    this.assertNotClosed();
    const row = this.db
      .prepare(
        `SELECT id, started_at_ms, finished_at_ms, status, error_code, error_message, stats_json
         FROM sync_runs
         WHERE id = ?`,
      )
      .get(id);

    if (!row) {
      return null;
    }

    const validatedRow = parseWithSchema(syncRunRowSchema, row, "sync run row");
    return {
      id: validatedRow.id,
      status: validatedRow.status,
      startedAt: validatedRow.started_at_ms,
      finishedAt: validatedRow.finished_at_ms,
      errorCode: validatedRow.error_code,
      errorMessage: validatedRow.error_message,
      stats: parseJsonWithSchema(
        validatedRow.stats_json,
        syncRunStatsSchema,
        `sync run ${validatedRow.id} stats`,
      ),
    };
  }

  pruneSyncHistory(limit: number): void {
    this.assertNotClosed();
    if (limit < 1) {
      return;
    }
    this.db.exec("BEGIN");
    try {
      const rows = parseWithSchema(
        syncRunIdRowSchema.array(),
        this.db
          .prepare(
            `SELECT id
             FROM sync_runs
             ORDER BY started_at_ms DESC
             LIMIT -1 OFFSET ?`,
          )
          .all(limit),
        "sync run history rows",
      );
      if (rows.length === 0) {
        this.db.exec("COMMIT");
        return;
      }

      const ids = rows.map((row) => row.id);
      const placeholders = ids.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM sync_runs WHERE id IN (${placeholders})`).run(...ids);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getActiveGenerationId(): number | null {
    this.assertNotClosed();
    const row = this.db
      .prepare(
        `SELECT id AS generation_id
         FROM generations
         WHERE is_active = 1`,
      )
      .get();
    return row
      ? parseWithSchema(activeGenerationRowSchema, row, "active generation row").generation_id
      : null;
  }

  listStagedGenerationIds(): number[] {
    this.assertNotClosed();
    const rows = parseWithSchema(
      generationIdRowSchema.array(),
      this.db
        .prepare(
          `SELECT id
           FROM generations
           WHERE is_active = 0
           ORDER BY id ASC`,
        )
        .all(),
      "staged generation rows",
    );
    return rows.map((row) => row.id);
  }

  createStagedGeneration(manifest: FlatManifest, now: number): number {
    this.assertNotClosed();
    this.db.exec("BEGIN");
    try {
      const generationInsert = this.db
        .prepare(
          `INSERT INTO generations (snapshot_id, retrieved_at, expires_at, committed_at_ms, is_active)
           VALUES (?, ?, ?, ?, 0)`,
        )
        .run(
          manifest.snapshotId ?? null,
          manifest.retrievedAt ?? null,
          manifest.expiresAt ?? null,
          now,
        );

      const generationId = Number(generationInsert.lastInsertRowid);

      const indexDefStmt = this.db.prepare(
        `INSERT INTO index_definitions (generation_id, name, cardinality, required, builtin)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const def of manifest.indexDefinitions) {
        indexDefStmt.run(
          generationId,
          def.name,
          def.cardinality,
          def.required ? 1 : 0,
          def.builtin ? 1 : 0,
        );
      }

      const assetStmt = this.db.prepare(
        `INSERT INTO assets (
          generation_id, asset_key, display_key, version, mime_type, media_kind, file_name, file_stem,
          byte_length, url, metadata_json, indexes_json, order_index, relative_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      );
      const indexStmt = this.db.prepare(
        `INSERT INTO asset_indexes (generation_id, asset_key, index_name, index_value)
         VALUES (?, ?, ?, ?)`,
      );

      manifest.assets.forEach((asset, assetOrder) => {
        assetStmt.run(
          generationId,
          asset.key,
          asset.displayKey,
          asset.version,
          asset.mimeType,
          asset.mediaKind,
          asset.fileName,
          asset.fileStem,
          asset.byteLength ?? null,
          asset.url,
          JSON.stringify(asset.metadata),
          JSON.stringify(asset.indexes),
          assetOrder,
        );

        for (const [indexName, indexValue] of Object.entries(asset.indexes)) {
          if (Array.isArray(indexValue)) {
            for (const v of new Set(indexValue)) {
              indexStmt.run(generationId, asset.key, indexName, v);
            }
          } else {
            indexStmt.run(generationId, asset.key, indexName, indexValue);
          }
        }
      });

      this.db.exec("COMMIT");
      return generationId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteGeneration(generationId: number): void {
    this.assertNotClosed();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM asset_indexes WHERE generation_id = ?`).run(generationId);
      this.db.prepare(`DELETE FROM assets WHERE generation_id = ?`).run(generationId);
      this.db.prepare(`DELETE FROM index_definitions WHERE generation_id = ?`).run(generationId);
      this.db.prepare(`DELETE FROM generations WHERE id = ?`).run(generationId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setAssetRelativePath(generationId: number, assetKey: string, relativePath: string): void {
    this.assertNotClosed();
    this.db
      .prepare(
        `UPDATE assets
         SET relative_path = ?
         WHERE generation_id = ? AND asset_key = ?`,
      )
      .run(relativePath, generationId, assetKey);
  }

  setAssetDownloadState(
    generationId: number,
    assetKey: string,
    relativePath: string,
    fallbackMimeType: string | null,
  ): void {
    this.assertNotClosed();
    this.db
      .prepare(
        `UPDATE assets
         SET
           relative_path = ?,
           mime_type = COALESCE(mime_type, ?)
         WHERE generation_id = ? AND asset_key = ?`,
      )
      .run(relativePath, fallbackMimeType, generationId, assetKey);
  }

  getGenerationAssets(generationId: number): GenerationAssetRow[] {
    this.assertNotClosed();
    return parseWithSchema(
      generationAssetRowSchema.array(),
      this.db
        .prepare(
          `SELECT
             asset_key AS assetKey,
             version,
             relative_path AS relativePath,
             mime_type AS mimeType,
             url
           FROM assets
           WHERE generation_id = ?
           ORDER BY order_index`,
        )
        .all(generationId),
      `generation ${generationId} asset rows`,
    );
  }

  activateGeneration(generationId: number, now: number): number | null {
    this.assertNotClosed();
    const previousActive = this.getActiveGenerationId();

    this.db.exec("BEGIN");
    try {
      this.db.prepare(`UPDATE generations SET is_active = 0 WHERE is_active = 1`).run();
      const result = this.db
        .prepare(`UPDATE generations SET is_active = 1, committed_at_ms = ? WHERE id = ?`)
        .run(now, generationId);
      if (result.changes !== 1) {
        throw new Error(`Cannot activate missing generation ${generationId}`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return previousActive;
  }

  clearPendingDeletionsForGeneration(generationId: number): void {
    this.assertNotClosed();
    const activeRelativePaths = this.getGenerationAssets(generationId).flatMap((row) =>
      row.relativePath ? [row.relativePath] : [],
    );
    this.deletePendingDeletionsByRelativePath(activeRelativePaths);
  }

  markPendingDeletion(
    assetKey: string,
    relativePath: string,
    generationId: number,
    deletionKey: string,
    deleteAfterMs: number,
  ): void {
    this.assertNotClosed();
    this.db
      .prepare(
        `INSERT INTO pending_deletions (
          deletion_key, logical_key, asset_key, relative_path, generation_id, delete_after_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(deletion_key)
        DO UPDATE SET
          logical_key = excluded.logical_key,
          asset_key = excluded.asset_key,
          relative_path = excluded.relative_path,
          generation_id = excluded.generation_id,
          delete_after_ms = excluded.delete_after_ms`,
      )
      .run(
        deletionKey,
        this.logicalKey(assetKey),
        assetKey,
        relativePath,
        generationId,
        deleteAfterMs,
      );
  }

  getExpiredPendingDeletions(now: number): PendingDeletion[] {
    this.assertNotClosed();
    return parseWithSchema(
      pendingDeletionSchema.array(),
      this.db
        .prepare(
          `SELECT deletion_key AS deletionKey, logical_key AS logicalKey, relative_path AS relativePath
           FROM pending_deletions
           WHERE delete_after_ms <= ?`,
        )
        .all(now),
      "expired pending deletions",
    );
  }

  deletePendingDeletions(deletionKeys: string[]): void {
    this.assertNotClosed();
    if (deletionKeys.length === 0) {
      return;
    }

    const placeholders = deletionKeys.map(() => "?").join(", ");
    this.db
      .prepare(`DELETE FROM pending_deletions WHERE deletion_key IN (${placeholders})`)
      .run(...deletionKeys);
  }

  deletePendingDeletionsByRelativePath(relativePaths: string[]): void {
    this.assertNotClosed();
    if (relativePaths.length === 0) {
      return;
    }

    const placeholders = relativePaths.map(() => "?").join(", ");
    this.db
      .prepare(`DELETE FROM pending_deletions WHERE relative_path IN (${placeholders})`)
      .run(...relativePaths);
  }

  getProtocolAssetTarget(assetKey: string): ProtocolAssetTarget | null {
    this.assertNotClosed();
    const activeGeneration = this.getActiveGenerationId();
    if (!activeGeneration) {
      return null;
    }

    const row = this.db
      .prepare(
        `SELECT relative_path
         FROM assets
         WHERE generation_id = ? AND asset_key = ?`,
      )
      .get(activeGeneration, assetKey);

    if (!row) {
      return null;
    }

    const validatedRow = parseWithSchema(protocolAssetTargetRowSchema, row, "protocol asset row");
    return {
      absolutePath: validatedRow.relative_path
        ? join(this.root, ...validatedRow.relative_path.split(/[\\/]/))
        : null,
    };
  }

  getAsset(assetKey: string): ResolvedMediaAsset | null {
    this.assertNotClosed();
    const activeGeneration = this.getActiveGenerationId();
    if (!activeGeneration) {
      return null;
    }

    const row = this.db
      .prepare(
        `SELECT
           generation_id AS generationId,
           asset_key AS assetKey,
           display_key AS displayKey,
           version,
           mime_type AS mimeType,
           media_kind AS mediaKind,
           byte_length AS byteLength,
           metadata_json AS metadata,
           indexes_json AS indexesJson,
           relative_path AS relativePath,
           url,
           file_stem AS fileStem,
           order_index AS orderIndex
         FROM assets
         WHERE generation_id = ? AND asset_key = ?`,
      )
      .get(activeGeneration, assetKey);

    if (!row) {
      return null;
    }

    const validatedRow = parseWithSchema(activeAssetRowSchema, row, `asset "${assetKey}"`);
    return this.buildResolvedAsset(validatedRow);
  }

  listByIndex(
    indexName: string,
    value: string,
    pagination?: PaginationInput,
  ): PaginationResult<ResolvedMediaAsset> {
    this.assertNotClosed();
    resolvePaginationWindow(pagination);

    const activeGeneration = this.getActiveGenerationId();
    if (!activeGeneration) {
      return { items: [], nextCursor: null };
    }

    const rows = parseWithSchema(
      activeAssetRowSchema.array(),
      this.db
        .prepare(
          `SELECT
             a.generation_id AS generationId,
             a.asset_key AS assetKey,
             a.display_key AS displayKey,
             a.version,
             a.mime_type AS mimeType,
             a.media_kind AS mediaKind,
             a.byte_length AS byteLength,
             a.metadata_json AS metadata,
             a.indexes_json AS indexesJson,
             a.relative_path AS relativePath,
             a.url,
             a.file_stem AS fileStem,
             a.order_index AS orderIndex
           FROM asset_indexes ai
           INNER JOIN assets a
             ON a.generation_id = ai.generation_id AND a.asset_key = ai.asset_key
           WHERE ai.generation_id = ? AND ai.index_name = ? AND ai.index_value = ?
           ORDER BY a.order_index`,
        )
        .all(activeGeneration, indexName, value),
      "index match rows",
    );

    const assets = rows.map((row) => this.buildResolvedAsset(row));
    return paginateArray(assets, pagination);
  }

  findByFileStem(stem: string, pagination?: PaginationInput): PaginationResult<FileStemMatch> {
    this.assertNotClosed();
    resolvePaginationWindow(pagination);

    const activeGeneration = this.getActiveGenerationId();
    if (!activeGeneration) {
      return { items: [], nextCursor: null };
    }

    const rows = parseWithSchema(
      activeAssetRowSchema.array(),
      this.db
        .prepare(
          `SELECT
             generation_id AS generationId,
             asset_key AS assetKey,
             display_key AS displayKey,
             version,
             mime_type AS mimeType,
             media_kind AS mediaKind,
             byte_length AS byteLength,
             metadata_json AS metadata,
             indexes_json AS indexesJson,
             relative_path AS relativePath,
             url,
             file_stem AS fileStem,
             order_index AS orderIndex
           FROM assets
           WHERE generation_id = ? AND file_stem = ?
           ORDER BY order_index`,
        )
        .all(activeGeneration, stem),
      "file stem match rows",
    );

    const matches: FileStemMatch[] = rows.map((row) => ({
      asset: this.buildResolvedAsset(row),
    }));
    return paginateArray(matches, pagination);
  }

  logicalKey(assetKey: string): string {
    return assetKey;
  }

  private buildResolvedAsset(row: ActiveAssetRow): ResolvedMediaAsset {
    const metadata = parseJsonWithSchema(
      row.metadata,
      jsonObjectSchema,
      `metadata for asset "${row.assetKey}"`,
    );
    const indexes = parseJsonWithSchema(
      row.indexesJson,
      jsonObjectSchema,
      `indexes for asset "${row.assetKey}"`,
    ) as Record<string, string | string[]>;

    let url: string;
    if (this.options.devPassthrough) {
      url = row.url;
      const origin = this.options.assetBaseUrlOrigin;
      if (origin) {
        try {
          const base = new URL(origin);
          const resolved = new URL(url);
          resolved.protocol = base.protocol;
          resolved.hostname = base.hostname;
          resolved.port = base.port;
          url = resolved.toString();
        } catch (err) {
          if (this.options.onWarn) {
            this.options.onWarn(`asset source for "${row.assetKey}"`, err);
          }
        }
      }
    } else {
      url = `media://asset/${encodeURIComponent(row.assetKey)}`;
    }

    return {
      key: row.assetKey,
      displayKey: row.displayKey,
      version: row.version,
      mimeType: row.mimeType,
      kind: row.mediaKind,
      byteLength: row.byteLength ?? undefined,
      url,
      metadata,
      indexes,
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS generations (
        id INTEGER PRIMARY KEY,
        snapshot_id TEXT,
        retrieved_at TEXT,
        expires_at TEXT,
        committed_at_ms INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS assets (
        generation_id INTEGER NOT NULL,
        asset_key TEXT NOT NULL,
        display_key TEXT NOT NULL,
        version TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        media_kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_stem TEXT NOT NULL,
        byte_length INTEGER,
        url TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        indexes_json TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        relative_path TEXT,
        PRIMARY KEY (generation_id, asset_key)
      );

      CREATE INDEX IF NOT EXISTS idx_assets_file_stem
        ON assets (generation_id, file_stem, order_index);

      CREATE TABLE IF NOT EXISTS asset_indexes (
        generation_id INTEGER NOT NULL,
        asset_key TEXT NOT NULL,
        index_name TEXT NOT NULL,
        index_value TEXT NOT NULL,
        PRIMARY KEY (generation_id, asset_key, index_name, index_value)
      );

      CREATE INDEX IF NOT EXISTS idx_asset_indexes_lookup
        ON asset_indexes (generation_id, index_name, index_value, asset_key);

      CREATE TABLE IF NOT EXISTS index_definitions (
        generation_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        cardinality TEXT NOT NULL,
        required INTEGER NOT NULL,
        builtin INTEGER NOT NULL,
        PRIMARY KEY (generation_id, name)
      );

      CREATE TABLE IF NOT EXISTS pending_deletions (
        deletion_key TEXT PRIMARY KEY,
        logical_key TEXT NOT NULL,
        asset_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        generation_id INTEGER NOT NULL,
        delete_after_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY,
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        stats_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS status_snapshot (
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        status_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope_type, scope_key)
      );
    `);
  }
}

function emptyStats(): SyncRunStats {
  return {
    totalAssets: 0,
    downloadedAssets: 0,
    skippedAssets: 0,
    bytesDownloaded: 0,
  };
}
