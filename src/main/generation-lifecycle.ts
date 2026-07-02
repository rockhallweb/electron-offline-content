import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { JsonValue, MediaCacheLogLevel } from "../shared/types.js";
import type { GenerationAssetRow, PendingDeletion } from "./database.js";

/** When `staleDeleteAfterMs` is omitted, replaced Blobs stay on disk this long (7 days). */
export const DEFAULT_STALE_DELETE_MS = 7 * 24 * 60 * 60 * 1000;

export type GenerationLifecycleLogHandler = (
  level: MediaCacheLogLevel,
  event: string,
  fields?: Record<string, JsonValue | undefined>,
) => void;

/**
 * Persistence operations the Generation lifecycle needs. `MediaCacheDatabase` satisfies this
 * structurally; tests can exercise lifecycle rules against a real database without reaching
 * through `MediaCache` internals.
 */
export interface GenerationLifecycleStore {
  getActiveGenerationId(): number | null;
  listStagedGenerationIds(): number[];
  deleteGeneration(generationId: number): void;
  getGenerationAssets(generationId: number): GenerationAssetRow[];
  activateGeneration(generationId: number, now: number): number | null;
  clearPendingDeletionsForGeneration(generationId: number): void;
  markPendingDeletion(
    assetKey: string,
    relativePath: string,
    generationId: number,
    deletionKey: string,
    deleteAfterMs: number,
  ): void;
  getExpiredPendingDeletions(now: number): PendingDeletion[];
  deletePendingDeletions(deletionKeys: string[]): void;
}

/** Result of {@link GenerationLifecycle.commitStagedGeneration}. */
export interface CommitStagedGenerationResult {
  /** Generation that was committed before this commit, or null on the first commit. */
  previousGenerationId: number | null;
}

/**
 * Owns the staged Generation lifecycle: commit (activation plus pending Blob deletion marking),
 * failed-sync rollback, orphaned staged Generation reconciliation, and delayed Blob pruning.
 * Rollback and reconciliation remove only the staged Generation's database rows; completed Blob
 * files stay on disk so the next sync can adopt them instead of re-downloading. Blobs no future
 * sync references are swept by `MediaCache.pruneUnreferencedBlobs` before storage limits are
 * enforced.
 */
export class GenerationLifecycle {
  constructor(
    private readonly storageRoot: string,
    private readonly db: GenerationLifecycleStore,
    private readonly options: {
      emitLog: GenerationLifecycleLogHandler;
      staleDeleteAfterMs?: number;
    },
  ) {}

  /**
   * Commits a staged Generation: activates it (deactivating the previous committed Generation in
   * the same transaction), clears pending deletions for Blob paths the new Generation references,
   * and marks Blob paths the previous Generation no longer uses for delayed deletion. Returns the
   * previously committed Generation id, or null on the first commit.
   */
  commitStagedGeneration(stagedGenerationId: number, now: number): CommitStagedGenerationResult {
    const previousGenerationId = this.db.activateGeneration(stagedGenerationId, now);
    this.db.clearPendingDeletionsForGeneration(stagedGenerationId);
    if (previousGenerationId) {
      this.markReplacedBlobsForDeletion(previousGenerationId, stagedGenerationId, now);
    }
    return { previousGenerationId };
  }

  /**
   * Deletes Blob files whose pending deletion delay has elapsed and removes their pending
   * deletion records.
   */
  pruneExpiredDeletions(now: number): void {
    const expired = this.db.getExpiredPendingDeletions(now);
    if (expired.length === 0) {
      this.options.emitLog("debug", "deletion_prune_skipped", { expired_count: 0 });
      return;
    }

    for (const deletion of expired) {
      const absolutePath = resolveStoredBlobPath(this.storageRoot, deletion.relativePath);
      if (absolutePath === null) {
        this.options.emitLog("warn", "pending_deletion_path_outside_storage_root", {
          relative_path: deletion.relativePath,
        });
        continue;
      }
      rmSync(absolutePath, { force: true });
      pruneEmptyParents(absolutePath, this.storageRoot);
    }

    this.db.deletePendingDeletions(expired.map((item) => item.deletionKey));
    this.options.emitLog("debug", "assets_pruned", { pruned_count: expired.length });
  }

  /**
   * Rolls back a staged Generation after a failed sync by deleting only its database rows.
   * Completed Blob files stay on disk so the next sync can adopt them instead of re-downloading —
   * on a slow or flaky connection this is what lets a large initial sync make forward progress
   * across failures. Blobs no future sync references are swept by `MediaCache.pruneUnreferencedBlobs`.
   */
  rollbackStagedGeneration(stagedGenerationId: number): void {
    this.db.deleteGeneration(stagedGenerationId);
  }

  /**
   * Removes staged Generations left behind by an interrupted sync (e.g. a crash before commit)
   * while preserving the committed Generation. Returns the active Generation id, or null when no
   * Generation has been committed yet.
   */
  reconcileOrphanedStagedGenerations(): number | null {
    const activeGenerationId = this.db.getActiveGenerationId();
    const stagedGenerationIds = this.db
      .listStagedGenerationIds()
      .filter((generationId) => generationId !== activeGenerationId);
    if (stagedGenerationIds.length === 0) {
      return activeGenerationId;
    }

    for (const stagedGenerationId of stagedGenerationIds) {
      // Completed Blobs stay on disk (see rollbackStagedGeneration); only the rows are removed.
      this.db.deleteGeneration(stagedGenerationId);
    }

    this.options.emitLog("warn", "orphaned_staged_generations_removed", {
      active_generation_id: activeGenerationId,
      removed_generation_ids: stagedGenerationIds,
      removed_generation_count: stagedGenerationIds.length,
    });
    return activeGenerationId;
  }

  /** Marks Blob paths the previous Generation no longer uses for delayed deletion. */
  private markReplacedBlobsForDeletion(
    previousGenerationId: number,
    stagedGenerationId: number,
    now: number,
  ): void {
    const previousAssets = this.db.getGenerationAssets(previousGenerationId);
    const nextAssets = new Map(
      this.db
        .getGenerationAssets(stagedGenerationId)
        .map((row) => [row.assetKey, row.relativePath]),
    );
    const deleteAfterMs = now + (this.options.staleDeleteAfterMs ?? DEFAULT_STALE_DELETE_MS);

    let markedCount = 0;
    for (const row of previousAssets) {
      const nextRelativePath = nextAssets.get(row.assetKey);
      if (row.relativePath && nextRelativePath !== row.relativePath) {
        this.db.markPendingDeletion(
          row.assetKey,
          row.relativePath,
          previousGenerationId,
          createPendingDeletionKey(row.assetKey, row.relativePath),
          deleteAfterMs,
        );
        markedCount += 1;
      }
    }
    this.options.emitLog("debug", "assets_marked_for_deletion", {
      previous_generation_id: previousGenerationId,
      active_generation_id: stagedGenerationId,
      marked_count: markedCount,
      delete_after_ms: deleteAfterMs,
    });
  }
}

function createPendingDeletionKey(assetKey: string, relativePath: string): string {
  return JSON.stringify([assetKey, relativePath]);
}

export function normalizeStoredRelativePath(relativePath: string): string {
  return relativePath.split(/[\\/]/).join("/");
}

/**
 * Resolves a stored relative Blob path against the storage root. Returns null when the resolved
 * path is the root itself or escapes it (e.g. a malformed or tampered `..` segment), so callers
 * never delete outside the cache.
 */
export function resolveStoredBlobPath(storageRoot: string, relativePath: string): string | null {
  const resolvedRoot = resolve(storageRoot);
  const absolutePath = resolve(resolvedRoot, normalizeStoredRelativePath(relativePath));
  return isInsideRoot(resolvedRoot, absolutePath) ? absolutePath : null;
}

function isInsideRoot(resolvedRoot: string, absolutePath: string): boolean {
  const relativeToRoot = relative(resolvedRoot, absolutePath);
  return (
    relativeToRoot !== "" &&
    relativeToRoot !== ".." &&
    !relativeToRoot.startsWith(`..${sep}`) &&
    !isAbsolute(relativeToRoot)
  );
}

export function pruneEmptyParents(pathToFile: string, storageRoot: string): void {
  const resolvedRoot = resolve(storageRoot);
  let current = dirname(resolve(pathToFile));
  while (isInsideRoot(resolvedRoot, current)) {
    if (existsSync(current) && readdirSync(current).length === 0) {
      rmSync(current, { recursive: true, force: true });
      current = dirname(current);
      continue;
    }
    break;
  }
}
