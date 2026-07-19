import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { StorageOwnershipError } from "../shared/errors.js";

const STORAGE_ROOT_LOCK_FILE_NAME = ".media-cache.lock";
const LOCAL_HOSTNAME = hostname();
const PROCESS_START_TIME_TOLERANCE_MS = 5_000;
const LOCAL_PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();

interface StorageRootLockMetadata {
  lockId: string;
  pid: number;
  hostname: string;
  storageRoot: string;
  acquiredAt: string;
  processStartedAt?: string;
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
    processStartedAt: LOCAL_PROCESS_STARTED_AT,
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
      !isRecordedProcessInstanceAlive(existingMetadata)
    ) {
      removeOwnedLockFile(lockFilePath, existingMetadata.lockId);
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
      ...(typeof parsed.processStartedAt === "string"
        ? { processStartedAt: parsed.processStartedAt }
        : {}),
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

function isRecordedProcessInstanceAlive(metadata: StorageRootLockMetadata): boolean {
  if (!isProcessAlive(metadata.pid)) {
    return false;
  }

  const recordedProcessStartedAt = metadata.processStartedAt
    ? Date.parse(metadata.processStartedAt)
    : null;
  const acquiredAt = Date.parse(metadata.acquiredAt);
  const processStartedAt = readProcessStartedAt(metadata.pid);
  if (processStartedAt !== null) {
    if (
      recordedProcessStartedAt !== null &&
      Number.isFinite(recordedProcessStartedAt) &&
      Math.abs(processStartedAt - recordedProcessStartedAt) > PROCESS_START_TIME_TOLERANCE_MS
    ) {
      return false;
    }
    if (
      recordedProcessStartedAt === null &&
      Number.isFinite(acquiredAt) &&
      processStartedAt > acquiredAt + PROCESS_START_TIME_TOLERANCE_MS
    ) {
      return false;
    }
  }

  // The process may have exited between the liveness and identity probes. If the start time
  // was unavailable for any other reason, remain conservative and preserve a possibly live
  // owner's lock.
  return processStartedAt !== null || isProcessAlive(metadata.pid);
}

function readProcessStartedAt(pid: number): number | null {
  try {
    const output =
      platform() === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().ToString('o')`,
            ],
            { encoding: "utf8", timeout: 2_000, windowsHide: true },
          )
        : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
            encoding: "utf8",
            env: { ...process.env, LC_ALL: "C" },
            timeout: 2_000,
            windowsHide: true,
          });
    const startedAt = Date.parse(output.trim());
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}
