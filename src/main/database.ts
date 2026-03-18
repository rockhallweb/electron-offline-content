import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { paginateArray, resolvePaginationWindow } from "../shared/pagination.js";
import type {
  FileStemMatch,
  MediaCacheStatus,
  PaginationInput,
  PaginationResult,
  ResolvedMediaContentItem,
  SyncRunSummary,
} from "../shared/types.js";
import type { NormalizedManifest } from "../shared/normalize.js";
import {
  activeAssetRowSchema,
  activeGenerationRowSchema,
  assetPathRowSchema,
  fileStemRowSchema,
  generationAssetKeyRowSchema,
  jsonObjectSchema,
  mediaCacheStatusSchema,
  paginationInputSchema,
  parseJsonWithSchema,
  parseWithSchema,
  pendingDeletionSchema,
  statusSnapshotRowSchema,
  stringRecordSchema,
  stringifyWithSchema,
  syncRunIdRowSchema,
  syncRunRowSchema,
  syncRunStatsSchema,
} from "../shared/validation.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface ActiveAssetRow {
  generationId: number;
  namespace: string;
  namespaceOrder: number;
  itemId: string;
  itemVersion: string;
  itemKind: ResolvedMediaContentItem["kind"];
  itemTitle: string | null;
  itemDescription: string | null;
  itemSummary: string | null;
  itemBlobsJson: string;
  itemMetadataJson: string;
  itemOrder: number;
  assetId: string;
  assetRole: string;
  assetKind: string;
  mimeType: string | null;
  byteLength: number | null;
  assetMetadataJson: string;
  relativePath: string | null;
  fileStem: string;
}

export interface PendingDeletion {
  logicalKey: string;
  relativePath: string;
}

export interface SyncRunStats {
  totalAssets: number;
  downloadedAssets: number;
  skippedAssets: number;
  bytesDownloaded: number;
}

export class MediaCacheDatabase {
  private readonly db: import("node:sqlite").DatabaseSync;

  constructor(private readonly root: string) {
    const sqliteDir = join(root, "sqlite");
    mkdirSync(sqliteDir, { recursive: true });
    this.db = new DatabaseSync(join(sqliteDir, "media-cache.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  loadStatus(): MediaCacheStatus | null {
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
    const validatedStatus = parseWithSchema(mediaCacheStatusSchema, status, "media cache status");
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
        .run(JSON.stringify(validatedStatus), now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createSyncRun(now: number): number {
    const stats = parseWithSchema(syncRunStatsSchema, emptyStats(), "sync run stats");
    const result = this.db
      .prepare(
        `INSERT INTO sync_runs (started_at_ms, status, stats_json)
         VALUES (?, 'running', ?)`,
      )
      .run(now, JSON.stringify(stats));
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
    const validatedStats = parseWithSchema(syncRunStatsSchema, stats, "sync run stats");
    this.db
      .prepare(
        `UPDATE sync_runs
         SET finished_at_ms = ?, status = ?, error_code = ?, error_message = ?, stats_json = ?
         WHERE id = ?`,
      )
      .run(now, status, errorCode, errorMessage, JSON.stringify(validatedStats), id);

    return this.getSyncRun(id)!;
  }

  getSyncRun(id: number): SyncRunSummary | null {
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
      return;
    }

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM sync_runs WHERE id IN (${placeholders})`).run(...ids);
  }

  getActiveGenerationId(): number | null {
    const row = this.db
      .prepare(
        `SELECT generation_id
         FROM active_generation
         WHERE scope_type = 'global' AND scope_key = '*'`,
      )
      .get();
    return row
      ? parseWithSchema(activeGenerationRowSchema, row, "active generation row").generation_id
      : null;
  }

  createStagedGeneration(manifest: NormalizedManifest, now: number): number {
    this.db.exec("BEGIN");
    try {
      const generationInsert = this.db
        .prepare(
          `INSERT INTO generations (
            scope_type, scope_key, snapshot_id, generated_at, status, created_at_ms,
            namespace_count, item_count, asset_count
          ) VALUES ('global', '*', ?, ?, 'staged', ?, ?, ?, ?)`,
        )
        .run(
          manifest.snapshotId ?? null,
          manifest.generatedAt ?? null,
          now,
          manifest.namespaces.length,
          manifest.namespaces.reduce((count, namespace) => count + namespace.items.length, 0),
          manifest.namespaces.reduce(
            (count, namespace) =>
              count +
              namespace.items.reduce((assetCount, item) => assetCount + item.assets.length, 0),
            0,
          ),
        );

      const generationId = Number(generationInsert.lastInsertRowid);
      const namespaceStmt = this.db.prepare(
        `INSERT INTO generation_namespaces (
          generation_id, namespace_key, label, metadata_json, order_index
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      const itemStmt = this.db.prepare(
        `INSERT INTO items (
          generation_id, namespace_key, item_id, version, kind, title, description,
          summary, blobs_json, metadata_json, order_index
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const assetStmt = this.db.prepare(
        `INSERT INTO assets (
          generation_id, namespace_key, item_id, asset_id, role, kind, resolved_version,
          asset_version, mime_type, file_name, file_stem, byte_length, source_json,
          metadata_json, order_index, relative_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      );

      manifest.namespaces.forEach((namespace, namespaceOrder) => {
        namespaceStmt.run(
          generationId,
          namespace.key,
          namespace.label ?? null,
          stringifyWithSchema(
            namespace.metadata,
            jsonObjectSchema,
            `metadata for namespace "${namespace.key}"`,
          ),
          namespaceOrder,
        );

        namespace.items.forEach((item, itemOrder) => {
          itemStmt.run(
            generationId,
            namespace.key,
            item.id,
            item.version,
            item.kind,
            item.title ?? null,
            item.description ?? null,
            item.summary ?? null,
            stringifyWithSchema(
              item.blobs,
              stringRecordSchema,
              `blobs for item "${namespace.key}/${item.id}"`,
            ),
            stringifyWithSchema(
              item.metadata,
              jsonObjectSchema,
              `metadata for item "${namespace.key}/${item.id}"`,
            ),
            itemOrder,
          );

          item.assets.forEach((asset, assetOrder) => {
            assetStmt.run(
              generationId,
              namespace.key,
              item.id,
              asset.id,
              asset.role,
              asset.kind,
              asset.resolvedVersion,
              asset.version ?? null,
              asset.mimeType ?? null,
              asset.normalizedFileName,
              asset.normalizedFileStem,
              asset.byteLength ?? null,
              JSON.stringify(asset.source),
              stringifyWithSchema(
                asset.metadata ?? {},
                jsonObjectSchema,
                `metadata for asset "${namespace.key}/${item.id}/${asset.id}"`,
              ),
              assetOrder,
            );
          });
        });
      });

      this.db.exec("COMMIT");
      return generationId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deleteGeneration(generationId: number): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM assets WHERE generation_id = ?`).run(generationId);
      this.db.prepare(`DELETE FROM items WHERE generation_id = ?`).run(generationId);
      this.db
        .prepare(`DELETE FROM generation_namespaces WHERE generation_id = ?`)
        .run(generationId);
      this.db.prepare(`DELETE FROM generations WHERE id = ?`).run(generationId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setAssetRelativePath(
    generationId: number,
    namespace: string,
    itemId: string,
    assetId: string,
    relativePath: string,
  ): void {
    this.db
      .prepare(
        `UPDATE assets
         SET relative_path = ?
         WHERE generation_id = ? AND namespace_key = ? AND item_id = ? AND asset_id = ?`,
      )
      .run(relativePath, generationId, namespace, itemId, assetId);
  }

  setAssetDownloadState(
    generationId: number,
    namespace: string,
    itemId: string,
    assetId: string,
    relativePath: string,
    fallbackMimeType: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE assets
         SET
           relative_path = ?,
           mime_type = COALESCE(mime_type, ?)
         WHERE generation_id = ? AND namespace_key = ? AND item_id = ? AND asset_id = ?`,
      )
      .run(relativePath, fallbackMimeType, generationId, namespace, itemId, assetId);
  }

  getGenerationAssets(generationId: number): ActiveAssetRow[] {
    return parseWithSchema(
      activeAssetRowSchema.array(),
      this.db
        .prepare(
          `SELECT
             assets.generation_id AS generationId,
             assets.namespace_key AS namespace,
             generation_namespaces.order_index AS namespaceOrder,
             items.item_id AS itemId,
             items.version AS itemVersion,
             items.kind AS itemKind,
             items.title AS itemTitle,
             items.description AS itemDescription,
             items.summary AS itemSummary,
             items.blobs_json AS itemBlobsJson,
             items.metadata_json AS itemMetadataJson,
             items.order_index AS itemOrder,
             assets.asset_id AS assetId,
             assets.role AS assetRole,
             assets.kind AS assetKind,
             assets.mime_type AS mimeType,
             assets.byte_length AS byteLength,
             assets.metadata_json AS assetMetadataJson,
             assets.relative_path AS relativePath,
             assets.file_stem AS fileStem
           FROM assets
           INNER JOIN items
             ON items.generation_id = assets.generation_id
            AND items.namespace_key = assets.namespace_key
            AND items.item_id = assets.item_id
           INNER JOIN generation_namespaces
             ON generation_namespaces.generation_id = assets.generation_id
            AND generation_namespaces.namespace_key = assets.namespace_key
           WHERE assets.generation_id = ?
           ORDER BY generation_namespaces.order_index, items.order_index, assets.order_index`,
        )
        .all(generationId),
      `generation ${generationId} asset rows`,
    );
  }

  activateGeneration(generationId: number, now: number): number | null {
    const previousActive = this.getActiveGenerationId();

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`UPDATE generations SET status = 'committed', committed_at_ms = ? WHERE id = ?`)
        .run(now, generationId);
      this.db
        .prepare(
          `DELETE FROM active_generation
           WHERE scope_type = 'global' AND scope_key = '*'`,
        )
        .run();
      this.db
        .prepare(
          `INSERT INTO active_generation (scope_type, scope_key, generation_id)
           VALUES ('global', '*', ?)`,
        )
        .run(generationId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return previousActive;
  }

  clearPendingDeletionsForGeneration(generationId: number): void {
    const logicalKeys = parseWithSchema(
      generationAssetKeyRowSchema.array(),
      this.db
        .prepare(
          `SELECT namespace_key AS namespaceKey, item_id AS itemId, asset_id AS assetId
           FROM assets
           WHERE generation_id = ?`,
        )
        .all(generationId),
      `generation ${generationId} deletion rows`,
    ).map((row) => createLogicalKey(row.namespaceKey, row.itemId, row.assetId));

    this.deletePendingDeletions(logicalKeys);
  }

  markPendingDeletion(
    logicalKey: string,
    namespace: string,
    itemId: string,
    assetId: string,
    relativePath: string,
    generationId: number,
    deleteAfterMs: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO pending_deletions (
          logical_key, namespace_key, item_id, asset_id, relative_path, generation_id, delete_after_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(logical_key)
        DO UPDATE SET
          relative_path = excluded.relative_path,
          generation_id = excluded.generation_id,
          delete_after_ms = excluded.delete_after_ms`,
      )
      .run(logicalKey, namespace, itemId, assetId, relativePath, generationId, deleteAfterMs);
  }

  getExpiredPendingDeletions(now: number): PendingDeletion[] {
    return parseWithSchema(
      pendingDeletionSchema.array(),
      this.db
        .prepare(
          `SELECT logical_key AS logicalKey, relative_path AS relativePath
           FROM pending_deletions
           WHERE delete_after_ms <= ?`,
        )
        .all(now),
      "expired pending deletions",
    );
  }

  deletePendingDeletions(logicalKeys: string[]): void {
    if (logicalKeys.length === 0) {
      return;
    }

    const placeholders = logicalKeys.map(() => "?").join(", ");
    this.db
      .prepare(`DELETE FROM pending_deletions WHERE logical_key IN (${placeholders})`)
      .run(...logicalKeys);
  }

  getAssetAbsolutePath(namespace: string, itemId: string, assetId: string): string | null {
    const activeGeneration = this.getActiveGenerationId();
    if (!activeGeneration) {
      return null;
    }

    const row = this.db
      .prepare(
        `SELECT relative_path
         FROM assets
         WHERE generation_id = ? AND namespace_key = ? AND item_id = ? AND asset_id = ?`,
      )
      .get(activeGeneration, namespace, itemId, assetId);

    if (!row) {
      return null;
    }

    const validatedRow = parseWithSchema(assetPathRowSchema, row, "asset path row");
    if (!validatedRow.relative_path) {
      return null;
    }

    return join(this.root, validatedRow.relative_path);
  }

  listNamespace(
    namespace: string,
    pagination?: PaginationInput,
  ): PaginationResult<ResolvedMediaContentItem> {
    const validatedPagination = parseWithSchema(
      paginationInputSchema.optional(),
      pagination,
      "namespace pagination input",
    );
    resolvePaginationWindow(validatedPagination);
    const rows = this.getResolvedRows("exact", namespace);
    return paginateArray(buildResolvedItems(rows), validatedPagination);
  }

  listNamespaceTree(
    prefix: string,
    pagination?: PaginationInput,
  ): PaginationResult<ResolvedMediaContentItem> {
    const validatedPagination = parseWithSchema(
      paginationInputSchema.optional(),
      pagination,
      "namespace tree pagination input",
    );
    resolvePaginationWindow(validatedPagination);
    const rows = this.getResolvedRows("tree", prefix);
    return paginateArray(buildResolvedItems(rows), validatedPagination);
  }

  getItem(namespace: string, id: string): ResolvedMediaContentItem | null {
    const rows = this.getResolvedRows("item", namespace, id);
    const items = buildResolvedItems(rows);
    return items[0] ?? null;
  }

  findByFileStem(
    stem: string,
    namespace: string | undefined,
    pagination?: PaginationInput,
  ): PaginationResult<FileStemMatch> {
    const activeGeneration = this.getActiveGenerationId();
    if (!activeGeneration) {
      return { items: [], nextCursor: null };
    }

    const validatedPagination = parseWithSchema(
      paginationInputSchema.optional(),
      pagination,
      "file stem pagination input",
    );
    resolvePaginationWindow(validatedPagination);

    const sql = `
      SELECT
        assets.namespace_key AS namespace,
        items.item_id AS itemId,
        assets.asset_id AS assetId
      FROM assets
      INNER JOIN items
        ON items.generation_id = assets.generation_id
       AND items.namespace_key = assets.namespace_key
       AND items.item_id = assets.item_id
      INNER JOIN generation_namespaces
        ON generation_namespaces.generation_id = assets.generation_id
       AND generation_namespaces.namespace_key = assets.namespace_key
      WHERE assets.generation_id = ?
        AND assets.file_stem = ?
        ${namespace ? "AND assets.namespace_key = ?" : ""}
      ORDER BY generation_namespaces.order_index, items.order_index, assets.order_index
    `;

    const matchRows = parseWithSchema(
      fileStemRowSchema.array(),
      namespace
        ? this.db.prepare(sql).all(activeGeneration, stem, namespace)
        : this.db.prepare(sql).all(activeGeneration, stem),
      "file stem match rows",
    );

    const uniqueItemKeys = new Map<string, string[]>();
    for (const row of matchRows) {
      const key = createLogicalKey(row.namespace, row.itemId);
      const existing = uniqueItemKeys.get(key);
      if (existing) {
        existing.push(row.assetId);
      } else {
        uniqueItemKeys.set(key, [row.assetId]);
      }
    }

    const matches: FileStemMatch[] = [];
    for (const [key, matchedAssetIds] of uniqueItemKeys.entries()) {
      const [namespaceKey, itemId] = parseLogicalItemKey(key);
      const item = this.getItem(namespaceKey, itemId);
      if (item) {
        matches.push({
          item,
          matchedAssetIds,
        });
      }
    }

    return paginateArray(matches, validatedPagination);
  }

  private getResolvedRows(
    mode: "exact" | "tree" | "item",
    namespace: string,
    itemId?: string,
  ): ActiveAssetRow[] {
    const activeGeneration = this.getActiveGenerationId();
    if (!activeGeneration) {
      return [];
    }

    const baseSql = `
      SELECT
        assets.generation_id AS generationId,
        assets.namespace_key AS namespace,
        generation_namespaces.order_index AS namespaceOrder,
        items.item_id AS itemId,
        items.version AS itemVersion,
        items.kind AS itemKind,
        items.title AS itemTitle,
        items.description AS itemDescription,
        items.summary AS itemSummary,
        items.blobs_json AS itemBlobsJson,
        items.metadata_json AS itemMetadataJson,
        items.order_index AS itemOrder,
        assets.asset_id AS assetId,
        assets.role AS assetRole,
        assets.kind AS assetKind,
        assets.mime_type AS mimeType,
        assets.byte_length AS byteLength,
        assets.metadata_json AS assetMetadataJson,
        assets.relative_path AS relativePath,
        assets.file_stem AS fileStem
      FROM assets
      INNER JOIN items
        ON items.generation_id = assets.generation_id
       AND items.namespace_key = assets.namespace_key
       AND items.item_id = assets.item_id
      INNER JOIN generation_namespaces
        ON generation_namespaces.generation_id = assets.generation_id
       AND generation_namespaces.namespace_key = assets.namespace_key
      WHERE assets.generation_id = ?
    `;

    if (mode === "exact") {
      return parseWithSchema(
        activeAssetRowSchema.array(),
        this.db
          .prepare(
            `${baseSql} AND assets.namespace_key = ? ORDER BY generation_namespaces.order_index, items.order_index, assets.order_index`,
          )
          .all(activeGeneration, namespace),
        `resolved asset rows for namespace "${namespace}"`,
      );
    }

    if (mode === "tree") {
      return parseWithSchema(
        activeAssetRowSchema.array(),
        this.db
          .prepare(
            `${baseSql}
             AND (assets.namespace_key = ? OR assets.namespace_key LIKE ?)
             ORDER BY generation_namespaces.order_index, items.order_index, assets.order_index`,
          )
          .all(activeGeneration, namespace, `${namespace}.%`),
        `resolved asset rows for namespace tree "${namespace}"`,
      );
    }

    if (!itemId) {
      return [];
    }

    return parseWithSchema(
      activeAssetRowSchema.array(),
      this.db
        .prepare(
          `${baseSql}
           AND assets.namespace_key = ?
           AND items.item_id = ?
           ORDER BY generation_namespaces.order_index, items.order_index, assets.order_index`,
        )
        .all(activeGeneration, namespace, itemId),
      `resolved asset rows for item "${namespace}/${itemId}"`,
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS generations (
        id INTEGER PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        snapshot_id TEXT,
        generated_at TEXT,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        committed_at_ms INTEGER,
        namespace_count INTEGER NOT NULL,
        item_count INTEGER NOT NULL,
        asset_count INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generation_namespaces (
        generation_id INTEGER NOT NULL,
        namespace_key TEXT NOT NULL,
        label TEXT,
        metadata_json TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        PRIMARY KEY (generation_id, namespace_key)
      );

      CREATE TABLE IF NOT EXISTS items (
        generation_id INTEGER NOT NULL,
        namespace_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        version TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT,
        description TEXT,
        summary TEXT,
        blobs_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        PRIMARY KEY (generation_id, namespace_key, item_id)
      );

      CREATE TABLE IF NOT EXISTS assets (
        generation_id INTEGER NOT NULL,
        namespace_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        resolved_version TEXT NOT NULL,
        asset_version TEXT,
        mime_type TEXT,
        file_name TEXT NOT NULL,
        file_stem TEXT NOT NULL,
        byte_length INTEGER,
        source_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        relative_path TEXT,
        PRIMARY KEY (generation_id, namespace_key, item_id, asset_id)
      );

      CREATE TABLE IF NOT EXISTS active_generation (
        scope_type TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        generation_id INTEGER NOT NULL,
        PRIMARY KEY (scope_type, scope_key)
      );

      CREATE TABLE IF NOT EXISTS pending_deletions (
        logical_key TEXT PRIMARY KEY,
        namespace_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
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

function buildResolvedItems(rows: ActiveAssetRow[]): ResolvedMediaContentItem[] {
  const items = new Map<string, ResolvedMediaContentItem>();

  for (const row of rows) {
    const key = `${row.namespace}|${row.itemId}`;
    let item = items.get(key);
    if (!item) {
      item = {
        namespace: row.namespace,
        id: row.itemId,
        version: row.itemVersion,
        kind: row.itemKind,
        title: row.itemTitle ?? undefined,
        description: row.itemDescription ?? undefined,
        summary: row.itemSummary ?? undefined,
        blobs: parseJsonWithSchema(
          row.itemBlobsJson,
          stringRecordSchema,
          `item blobs for "${row.namespace}/${row.itemId}"`,
        ),
        metadata: parseJsonWithSchema(
          row.itemMetadataJson,
          jsonObjectSchema,
          `item metadata for "${row.namespace}/${row.itemId}"`,
        ),
        assets: [],
      };
      items.set(key, item);
    }

    item.assets.push({
      id: row.assetId,
      role: row.assetRole,
      kind: row.assetKind,
      mimeType: row.mimeType ?? undefined,
      byteLength: row.byteLength ?? undefined,
      url: buildMediaUrl(row.namespace, row.itemId, row.assetId),
      metadata: parseJsonWithSchema(
        row.assetMetadataJson,
        jsonObjectSchema,
        `asset metadata for "${row.namespace}/${row.itemId}/${row.assetId}"`,
      ),
    });
  }

  return [...items.values()];
}

function buildMediaUrl(namespace: string, itemId: string, assetId: string): string {
  return `media://asset/${encodeURIComponent(namespace)}/${encodeURIComponent(itemId)}/${encodeURIComponent(assetId)}`;
}

function createLogicalKey(...parts: string[]): string {
  return JSON.stringify(parts);
}

function parseLogicalItemKey(key: string): [string, string] {
  const parsed = JSON.parse(key) as unknown;
  if (
    Array.isArray(parsed) &&
    parsed.length === 2 &&
    parsed.every((entry) => typeof entry === "string")
  ) {
    return parsed as [string, string];
  }

  throw new Error(`Invalid logical item key: ${key}`);
}

function emptyStats(): SyncRunStats {
  return {
    totalAssets: 0,
    downloadedAssets: 0,
    skippedAssets: 0,
    bytesDownloaded: 0,
  };
}
