import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { StorageOwnershipError } from "../shared/errors.js";

const STORAGE_ROOT_LOCK_FILE_NAME = ".media-cache.lock";
const LOCAL_HOSTNAME = hostname();

interface StorageRootLockMetadata {
  lockId: string;
  pid: number;
  hostname: string;
  storageRoot: string;
  acquiredAt: string;
}

export interface StorageRootLockHandle {
  release(): void;
}

const activeLocks = new Map<
  string,
  {
    owner: object;
    handle: StorageRootLockHandle;
  }
>();

let storageRootLockEnabled = true;
let cleanupHookInstalled = false;

export function acquireStorageRootLock(
  storageRoot: string,
  owner: object,
): StorageRootLockHandle | null {
  if (!storageRootLockEnabled) {
    return null;
  }

  const activeLock = activeLocks.get(storageRoot);
  if (activeLock) {
    if (activeLock.owner === owner) {
      return activeLock.handle;
    }
    // Same-process collision: the active lock may not have written a file yet, so avoid a
    // misleading PID/hostname message that points back to the current process.
    throw createOwnershipError(storageRoot, join(storageRoot, STORAGE_ROOT_LOCK_FILE_NAME), null);
  }

  installCleanupHook();
  return tryAcquireStorageRootLock(storageRoot, owner, false);
}

export function resetStorageRootLocksForTests(): void {
  cleanupActiveLocks();
}

export function disableStorageRootLockForTests(): void {
  storageRootLockEnabled = false;
  cleanupActiveLocks();
}

export function enableStorageRootLockForTests(): void {
  storageRootLockEnabled = true;
  cleanupActiveLocks();
}

function tryAcquireStorageRootLock(
  storageRoot: string,
  owner: object,
  hasReclaimedStaleLock: boolean,
): StorageRootLockHandle {
  const lockFilePath = join(storageRoot, STORAGE_ROOT_LOCK_FILE_NAME);
  const metadata: StorageRootLockMetadata = {
    lockId: randomUUID(),
    pid: process.pid,
    hostname: LOCAL_HOSTNAME,
    storageRoot,
    acquiredAt: new Date().toISOString(),
  };

  try {
    writeFileSync(lockFilePath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }

    const existingMetadata = readLockMetadata(lockFilePath);
    if (
      !hasReclaimedStaleLock &&
      existingMetadata?.hostname === LOCAL_HOSTNAME &&
      !isProcessAlive(existingMetadata.pid)
    ) {
      rmSync(lockFilePath, { force: true });
      return tryAcquireStorageRootLock(storageRoot, owner, true);
    }

    throw createOwnershipError(storageRoot, lockFilePath, existingMetadata);
  }

  let released = false;
  const handle: StorageRootLockHandle = {
    release() {
      if (released) {
        return;
      }
      released = true;

      const activeLock = activeLocks.get(storageRoot);
      if (activeLock?.handle === handle) {
        activeLocks.delete(storageRoot);
      }

      removeOwnedLockFile(lockFilePath, metadata.lockId);
    },
  };

  activeLocks.set(storageRoot, {
    owner,
    handle,
  });
  return handle;
}

function installCleanupHook(): void {
  if (cleanupHookInstalled) {
    return;
  }
  cleanupHookInstalled = true;
  process.once("exit", cleanupActiveLocks);
}

function cleanupActiveLocks(): void {
  const handles = [...activeLocks.values()].map((entry) => entry.handle);
  for (const handle of handles) {
    handle.release();
  }
}

function removeOwnedLockFile(lockFilePath: string, expectedLockId: string): void {
  const metadata = readLockMetadata(lockFilePath);
  if (metadata?.lockId !== expectedLockId) {
    return;
  }
  rmSync(lockFilePath, { force: true });
}

function readLockMetadata(lockFilePath: string): StorageRootLockMetadata | null {
  try {
    return parseLockMetadata(readFileSync(lockFilePath, "utf8"));
  } catch {
    return null;
  }
}

function parseLockMetadata(raw: string): StorageRootLockMetadata | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StorageRootLockMetadata>;
    if (
      typeof parsed.lockId !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.storageRoot !== "string" ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return null;
    }
    return {
      lockId: parsed.lockId,
      pid: parsed.pid,
      hostname: parsed.hostname,
      storageRoot: parsed.storageRoot,
      acquiredAt: parsed.acquiredAt,
    };
  } catch {
    return null;
  }
}

function createOwnershipError(
  storageRoot: string,
  lockFilePath: string,
  metadata: Pick<StorageRootLockMetadata, "hostname" | "pid" | "storageRoot"> | null,
): StorageOwnershipError {
  if (metadata) {
    return new StorageOwnershipError(
      `Storage root "${storageRoot}" is already in use by process ${metadata.pid} on host ${metadata.hostname}. Lock file: ${lockFilePath}. ` +
        "If the recorded process is gone but belonged to another OS user, delete the lock file manually.",
    );
  }

  return new StorageOwnershipError(
    `Storage root "${storageRoot}" is already in use. Lock file: ${lockFilePath}`,
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // `EPERM` means another OS user may own the PID. Treat that as alive so we never steal a
    // lock from a running process; cross-user stale locks must be removed manually.
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}
