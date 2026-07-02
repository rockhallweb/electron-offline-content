import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { JsonValue, MediaCacheLogLevel } from "../shared/types.js";
import type { GenerationAssetRow } from "./database.js";

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
}

/**
 * Owns staged Generation cleanup rules: failed-sync rollback and orphaned staged Generation
 * reconciliation. Blob files referenced only by a staged Generation are removed; Blob files
 * shared with the committed Generation are preserved.
 */
export class GenerationLifecycle {
  constructor(
    private readonly storageRoot: string,
    private readonly db: GenerationLifecycleStore,
    private readonly options: {
      emitLog: GenerationLifecycleLogHandler;
    },
  ) {}

  /**
   * Rolls back a staged Generation after a failed sync: removes Blob files that only the staged
   * Generation references, then deletes the staged Generation rows. The committed Generation and
   * its Blobs remain untouched.
   */
  rollbackStagedGeneration(stagedGenerationId: number): void {
    this.cleanupStagedGenerationFiles(stagedGenerationId, this.db.getActiveGenerationId());
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
      this.cleanupStagedGenerationFiles(stagedGenerationId, activeGenerationId);
      this.db.deleteGeneration(stagedGenerationId);
    }

    this.options.emitLog("warn", "orphaned_staged_generations_removed", {
      active_generation_id: activeGenerationId,
      removed_generation_ids: stagedGenerationIds,
      removed_generation_count: stagedGenerationIds.length,
    });
    return activeGenerationId;
  }

  /** Removes staged-only Blob files; Blob paths shared with the active Generation survive. */
  private cleanupStagedGenerationFiles(
    stagedGenerationId: number,
    activeGenerationId: number | null,
  ): void {
    const activePaths = new Set(
      activeGenerationId
        ? this.db
            .getGenerationAssets(activeGenerationId)
            .flatMap((row) =>
              row.relativePath ? [normalizeStoredRelativePath(row.relativePath)] : [],
            )
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

      const absolutePath = resolveStoredBlobPath(this.storageRoot, normalizedRelativePath);
      if (absolutePath === null) {
        this.options.emitLog("warn", "staged_blob_path_outside_storage_root", {
          staged_generation_id: stagedGenerationId,
          relative_path: row.relativePath,
        });
        continue;
      }
      rmSync(absolutePath, { force: true });
      pruneEmptyParents(absolutePath, this.storageRoot);
    }
  }
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
