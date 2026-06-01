import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GenerationAssetRow, MediaCacheDatabase } from "./database.js";

type GenerationLifecycleDatabase = Pick<
  MediaCacheDatabase,
  | "activateGeneration"
  | "clearPendingDeletionsForGeneration"
  | "deleteGeneration"
  | "getActiveGenerationId"
  | "getGenerationAssets"
  | "listStagedGenerationIds"
  | "markPendingDeletion"
>;

export interface OrphanedStagedGenerationReconciliation {
  activeGenerationId: number | null;
  removedGenerationIds: number[];
}

export interface GenerationCommitResult {
  previousGenerationId: number | null;
  activeGenerationId: number;
  markedForDeletionCount: number;
  deleteAfterMs: number | null;
}

export class GenerationLifecycle {
  constructor(
    private readonly storageRoot: string,
    private readonly db: GenerationLifecycleDatabase,
  ) {}

  reconcileOrphanedStagedGenerations(): OrphanedStagedGenerationReconciliation {
    const activeGenerationId = this.db.getActiveGenerationId();
    const stagedGenerationIds = this.db
      .listStagedGenerationIds()
      .filter((generationId) => generationId !== activeGenerationId);

    for (const stagedGenerationId of stagedGenerationIds) {
      this.rollbackStagedGeneration(stagedGenerationId, activeGenerationId);
    }

    return {
      activeGenerationId,
      removedGenerationIds: stagedGenerationIds,
    };
  }

  rollbackStagedGeneration(
    stagedGenerationId: number,
    activeGenerationId = this.db.getActiveGenerationId(),
  ): void {
    this.cleanupStagedGenerationFiles(stagedGenerationId, activeGenerationId);
    this.db.deleteGeneration(stagedGenerationId);
  }

  commitStagedGeneration(options: {
    stagedGenerationId: number;
    now: number;
    staleDeleteAfterMs: number;
  }): GenerationCommitResult {
    const { stagedGenerationId, now, staleDeleteAfterMs } = options;
    const previousGenerationId = this.db.activateGeneration(stagedGenerationId, now);
    this.db.clearPendingDeletionsForGeneration(stagedGenerationId);
    const deletionResult =
      previousGenerationId === null
        ? { markedForDeletionCount: 0, deleteAfterMs: null }
        : this.markRemovedAssetsForDeletion({
            previousGenerationId,
            activeGenerationId: stagedGenerationId,
            deleteAfterMs: now + staleDeleteAfterMs,
          });

    return {
      previousGenerationId,
      activeGenerationId: stagedGenerationId,
      ...deletionResult,
    };
  }

  private cleanupStagedGenerationFiles(
    stagedGenerationId: number,
    activeGenerationId: number | null,
  ): void {
    const activePaths = new Set(
      activeGenerationId
        ? this.db.getGenerationAssets(activeGenerationId).flatMap((row) => relativePathEntries(row))
        : [],
    );

    for (const row of this.db.getGenerationAssets(stagedGenerationId)) {
      if (!row.relativePath) {
        continue;
      }

      const normalizedRelativePath = normalizeStoredRelativePath(row.relativePath);
      if (activePaths.has(normalizedRelativePath)) {
        continue;
      }

      const absolutePath = join(this.storageRoot, normalizedRelativePath);
      rmSync(absolutePath, { force: true });
      pruneEmptyParents(absolutePath, this.storageRoot);
    }
  }

  private markRemovedAssetsForDeletion(options: {
    previousGenerationId: number;
    activeGenerationId: number;
    deleteAfterMs: number;
  }): Pick<GenerationCommitResult, "deleteAfterMs" | "markedForDeletionCount"> {
    const previousAssets = this.db.getGenerationAssets(options.previousGenerationId);
    const nextAssets = new Map(
      this.db
        .getGenerationAssets(options.activeGenerationId)
        .map((row) => [row.assetKey, row.relativePath]),
    );

    let markedForDeletionCount = 0;
    for (const row of previousAssets) {
      const nextRelativePath = nextAssets.get(row.assetKey);
      if (row.relativePath && nextRelativePath !== row.relativePath) {
        this.db.markPendingDeletion(
          row.assetKey,
          row.relativePath,
          options.previousGenerationId,
          createPendingDeletionKey(row.assetKey, row.relativePath),
          options.deleteAfterMs,
        );
        markedForDeletionCount += 1;
      }
    }

    return {
      markedForDeletionCount,
      deleteAfterMs: options.deleteAfterMs,
    };
  }
}

function relativePathEntries(row: GenerationAssetRow): string[] {
  return row.relativePath ? [normalizeStoredRelativePath(row.relativePath)] : [];
}

function normalizeStoredRelativePath(relativePath: string): string {
  return relativePath.split(/[\\/]/).join("/");
}

function createPendingDeletionKey(assetKey: string, relativePath: string): string {
  return JSON.stringify([assetKey, relativePath]);
}

function pruneEmptyParents(pathToFile: string, storageRoot: string): void {
  let current = dirname(pathToFile);
  while (current.startsWith(storageRoot) && current !== storageRoot) {
    if (existsSync(current) && readdirSync(current).length === 0) {
      rmSync(current, { recursive: true, force: true });
      current = dirname(current);
      continue;
    }
    break;
  }
}
