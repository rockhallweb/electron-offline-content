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
  SyncRunStats,
  SyncRunSummary,
} from "../shared/types.js";
import type { NormalizedManifest } from "../shared/normalize.js";
import {
  activeAssetRowSchema,
  activeGenerationRowSchema,
  fileStemRowSchema,
  jsonObjectSchema,
  mediaCacheStatusSchema,
  parseJsonWithSchema,
  parseWithSchema,
  pendingDeletionSchema,
  protocolAssetTargetRowSchema,
  statusSnapshotRowSchema,
  stringRecordSchema,
  stringifyWithSchema,
  syncRunIdRowSchema,
  syncRunRowSchema,
  syncRunStatsSchema,
} from "../internal/validation.js";
import { consoleWarnResolveAssetBaseUrlFallback } from "../internal/url-warn.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface ActiveAssetRow {
  generationId: number;
  namespace: string;
  namespaceOrder: number;
  itemId: string;
  itemVersion: string;
  itemKind: string;
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
  sourceJson: string;
  fileStem: string;
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
       * Not called for invalid `source_json` (parse error or missing url) — those throw.
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
      this.db.prepare(`DELETE FROM active_generation`).run();
      this.db.prepare(`DELETE FROM assets`).run();
      this.db.prepare(`DELETE FROM items`).run();
      this.db.prepare(`DELETE FROM generation_namespaces`).run();
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
    this.assertNotClosed();
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
          // `generated_at` is a legacy column name; we persist the normalized effective retrieval time.
          manifest.retrievedAt ?? null,
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
          asset_version, manifest_mime_type, manifest_file_name, mime_type, file_name,
          file_stem, byte_length, source_json, resolved_request_json, metadata_json,
          order_index, has_precise_manifest_fields, relative_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
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
              asset.mimeType ?? null, // manifest_mime_type: preserve original manifest value
              asset.fileName ?? null,
              asset.mimeType ?? null, // mime_type: effective value, may be overridden after download
              asset.normalizedFileName,
              asset.normalizedFileStem,
              asset.byteLength ?? null,
              JSON.stringify(asset.source),
              // resolved_request_json is initialised to source_json; reserved for a future
              // feature that will persist the resolveAssetRequest() result for reuse across
              // sync generations without re-invoking the callback.
              JSON.stringify(asset.source),
              stringifyWithSchema(
                asset.metadata ?? {},
                jsonObjectSchema,
                `metadata for asset "${namespace.key}/${item.id}/${asset.id}"`,
              ),
              assetOrder,
              1,
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
    this.assertNotClosed();
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
    this.assertNotClosed();
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
    this.assertNotClosed();
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
    this.assertNotClosed();
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
             assets.source_json AS sourceJson,
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
    this.assertNotClosed();
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
    this.assertNotClosed();
    const activeRelativePaths = this.getGenerationAssets(generationId).flatMap((row) =>
      row.relativePath ? [row.relativePath] : [],
    );
    this.deletePendingDeletionsByRelativePath(activeRelativePaths);
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
    this.assertNotClosed();
    this.db
      .prepare(
        `INSERT INTO pending_deletions (
          deletion_key, logical_key, namespace_key, item_id, asset_id, relative_path, generation_id, delete_after_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(deletion_key)
        DO UPDATE SET
          logical_key = excluded.logical_key,
          relative_path = excluded.relative_path,
          generation_id = excluded.generation_id,
          delete_after_ms = excluded.delete_after_ms`,
      )
      .run(
        createPendingDeletionKey(logicalKey, relativePath),
        logicalKey,
        namespace,
        itemId,
        assetId,
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

  getProtocolAssetTarget(
    namespace: string,
    itemId: string,
    assetId: string,
  ): ProtocolAssetTarget | null {
    this.assertNotClosed();
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

    const validatedRow = parseWithSchema(protocolAssetTargetRowSchema, row, "protocol asset row");
    return {
      absolutePath: validatedRow.relative_path ? join(this.root, validatedRow.relative_path) : null,
    };
  }

  listNamespace(
    namespace: string,
    pagination?: PaginationInput,
  ): PaginationResult<ResolvedMediaContentItem> {
    this.assertNotClosed();
    resolvePaginationWindow(pagination);
    const rows = this.getResolvedRows("exact", namespace);
    return paginateArray(this.buildResolvedItems(rows), pagination);
  }

  listNamespaceTree(
    prefix: string,
    pagination?: PaginationInput,
  ): PaginationResult<ResolvedMediaContentItem> {
    this.assertNotClosed();
    resolvePaginationWindow(pagination);
    const rows = this.getResolvedRows("tree", prefix);
    return paginateArray(this.buildResolvedItems(rows), pagination);
  }

  getItem(namespace: string, id: string): ResolvedMediaContentItem | null {
    this.assertNotClosed();
    const rows = this.getResolvedRows("item", namespace, id);
    const items = this.buildResolvedItems(rows);
    return items[0] ?? null;
  }

  findByFileStem(
    stem: string,
    namespace: string | undefined,
    pagination?: PaginationInput,
  ): PaginationResult<FileStemMatch> {
    this.assertNotClosed();
    resolvePaginationWindow(pagination);

    const activeGeneration = this.getActiveGenerationId();
    if (!activeGeneration) {
      return { items: [], nextCursor: null };
    }

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

    return paginateArray(matches, pagination);
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
        assets.source_json AS sourceJson,
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

  private buildResolvedItems(rows: ActiveAssetRow[]): ResolvedMediaContentItem[] {
    const items = new Map<string, ResolvedMediaContentItem>();

    for (const row of rows) {
      const key = `${row.namespace}|${row.itemId}`;
      let item = items.get(key);
      if (!item) {
        item = {
          namespace: row.namespace,
          id: row.itemId,
          version: row.itemVersion,
          kind: row.itemKind as ResolvedMediaContentItem["kind"],
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
          assetsByRole: {},
        };
        items.set(key, item);
      }

      const resolvedAsset = {
        id: row.assetId,
        role: row.assetRole,
        kind: row.assetKind,
        mimeType: row.mimeType ?? undefined,
        byteLength: row.byteLength ?? undefined,
        url: this.options.devPassthrough
          ? resolveAssetBaseUrl(
              row.sourceJson,
              this.options.assetBaseUrlOrigin,
              `asset source for "${row.namespace}/${row.itemId}/${row.assetId}"`,
              this.options.onWarn,
            )
          : buildMediaUrl(row.namespace, row.itemId, row.assetId),
        metadata: parseJsonWithSchema(
          row.assetMetadataJson,
          jsonObjectSchema,
          `asset metadata for "${row.namespace}/${row.itemId}/${row.assetId}"`,
        ),
      };
      item.assets.push(resolvedAsset);
      // First asset for a role wins; duplicates remain in `assets` (manifest order).
      item.assetsByRole[resolvedAsset.role] ??= resolvedAsset;
    }

    return [...items.values()];
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
        manifest_mime_type TEXT,
        manifest_file_name TEXT,
        mime_type TEXT,
        file_name TEXT NOT NULL,
        file_stem TEXT NOT NULL,
        byte_length INTEGER,
        source_json TEXT NOT NULL,
        resolved_request_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        has_precise_manifest_fields INTEGER NOT NULL DEFAULT 1,
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
        deletion_key TEXT PRIMARY KEY,
        logical_key TEXT NOT NULL,
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

function buildMediaUrl(namespace: string, itemId: string, assetId: string): string {
  return `media://asset/${encodeURIComponent(namespace)}/${encodeURIComponent(itemId)}/${encodeURIComponent(assetId)}`;
}

/**
 * Dev passthrough: parse `source_json` and optionally rewrite URL origin.
 * @param onWarn Invoked only when origin override fails (graceful fallback). Parse errors and
 *   missing `url` throw without calling `onWarn` — catch the error to observe those failures.
 */
function resolveAssetBaseUrl(
  sourceJson: string,
  assetBaseUrlOrigin: string | null,
  contextLabel: string,
  onWarn?: (contextLabel: string, err: unknown) => void,
): string {
  // Data-integrity error — do not emit resolve_asset_base_url_fallback (implies graceful recovery).
  // The try/catch below handles origin-override failures and *does* fall back to the original URL.
  let parsed: { url?: string };
  try {
    parsed = JSON.parse(sourceJson) as { url?: string };
  } catch (err) {
    throw new Error(
      `${contextLabel}: Failed to parse source_json (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  if (typeof parsed?.url !== "string" || !parsed?.url) {
    throw new Error(`${contextLabel}: source_json missing url`);
  }
  const url = parsed.url;

  if (!assetBaseUrlOrigin) {
    return url;
  }

  try {
    const origin = new URL(assetBaseUrlOrigin);
    const resolved = new URL(url);
    resolved.protocol = origin.protocol;
    resolved.hostname = origin.hostname;
    // normalizeAssetBaseUrl stores parsed.origin, which strips explicit default ports (e.g. :443).
    resolved.port = origin.port;
    return resolved.toString();
  } catch (err) {
    if (onWarn) {
      onWarn(contextLabel, err);
    } else {
      consoleWarnResolveAssetBaseUrlFallback(contextLabel, err);
    }
    return url;
  }
}

function createLogicalKey(...parts: string[]): string {
  return JSON.stringify(parts);
}

function createPendingDeletionKey(logicalKey: string, relativePath: string): string {
  return JSON.stringify([logicalKey, relativePath]);
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
