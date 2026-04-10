import { StoreValidationError } from "./errors.js";
import type { FlatManifest } from "./types.js";

/**
 * Validates flat manifest metadata (currently only `expiresAt`).
 * All per-asset normalization happens inside `MediaStore._serialize()`.
 */
export function validateFlatManifest(manifest: FlatManifest): FlatManifest {
  if (manifest.expiresAt !== undefined) {
    normalizeExpiration(manifest.expiresAt);
  }
  return manifest;
}

const ISO_8601_OFFSET_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeExpiration(expiresAt: string): void {
  if (!ISO_8601_OFFSET_TIMESTAMP.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) {
    throw new StoreValidationError(
      "Store expiresAt must be an ISO 8601 timestamp with a timezone offset or Z suffix.",
    );
  }
}
