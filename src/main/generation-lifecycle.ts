import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GenerationAssetRow, MediaCacheDatabase } from "./database.js";

type GenerationLifecycleDatabase = Pick<
  MediaCacheDatabase,
  "deleteGeneration" | "getActiveGenerationId" | "getGenerationAssets" | "listStagedGenerationIds"
>;

export interface OrphanedStagedGenerationReconciliation {
  activeGenerationId: number | null;
  removedGenerationIds: number[];
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
}

function relativePathEntries(row: GenerationAssetRow): string[] {
  return row.relativePath ? [normalizeStoredRelativePath(row.relativePath)] : [];
}

function normalizeStoredRelativePath(relativePath: string): string {
  return relativePath.split(/[\\/]/).join("/");
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
