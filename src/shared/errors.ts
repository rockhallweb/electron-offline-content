import type { SerializedMediaCacheError } from "./types.js";

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

export class ManifestValidationError extends MediaCacheError {
  constructor(message: string) {
    super(message, "MANIFEST_VALIDATION_ERROR");
    this.name = "ManifestValidationError";
  }
}

export class StorageLimitError extends MediaCacheError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "STORAGE_LIMIT_ERROR", options);
    this.name = "StorageLimitError";
  }
}

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
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOSPC"
  );
}
