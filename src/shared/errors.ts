import type { SerializedMediaCacheError } from "./types.js";

/**
 * Base class for cache errors; use `code` for stable programmatic handling.
 * @param message - Human-readable error description.
 * @param code - Machine-readable error code for branching (for example `SYNC_FAILURE`).
 * @param options - Standard `ErrorOptions` (e.g. `{ cause }`).
 */
export class MediaCacheError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MediaCacheError";
  }
}

/** Manifest from `resolveManifest` is missing or inconsistent (namespaces, items, or assets). */
export class ManifestValidationError extends MediaCacheError {
  constructor(message: string) {
    super(message, "MANIFEST_VALIDATION_ERROR");
    this.name = "ManifestValidationError";
  }
}

/** Manifest-derived URLs have passed their declared expiration time and must not be downloaded. */
export class ManifestExpiredError extends MediaCacheError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "MANIFEST_EXPIRED", options);
    this.name = "ManifestExpiredError";
  }
}

/** Another process or cache instance already owns the configured storage root. */
export class StorageOwnershipError extends MediaCacheError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "STORAGE_OWNERSHIP_ERROR", options);
    this.name = "StorageOwnershipError";
  }
}

/**
 * Cache would exceed `maxCacheBytes`, violate `reserveFreeBytes`, disk is full (`ENOSPC`), or a
 * commit would leave insufficient free space.
 */
export class StorageLimitError extends MediaCacheError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "STORAGE_LIMIT_ERROR", options);
    this.name = "StorageLimitError";
  }
}

/** Persisted state on disk fails validation (for example a corrupt status snapshot). */
export class DataValidationError extends MediaCacheError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "DATA_VALIDATION_ERROR", options);
    this.name = "DataValidationError";
  }
}

/** Network or HTTP failure while downloading an asset during sync (may be retryable internally). */
export class SyncFailureError extends MediaCacheError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "SYNC_FAILURE", options);
    this.name = "SyncFailureError";
  }
}

export function toSerializedError(error: unknown): SerializedMediaCacheError {
  if (error instanceof MediaCacheError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      code: "UNKNOWN_ERROR",
      message: error.message,
    };
  }

  return {
    name: "UnknownError",
    code: "UNKNOWN_ERROR",
    message: String(error),
  };
}

export function isNoSpaceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    collectErrorChain(error).some(
      (entry) => "code" in entry && (entry as NodeJS.ErrnoException).code === "ENOSPC",
    )
  );
}

function collectErrorChain(error: Error): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;

  while (current instanceof Error && !chain.includes(current)) {
    chain.push(current);
    current = current.cause;
  }

  return chain;
}
