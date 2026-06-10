import { StoreValidationError } from "./errors.js";
import { mediaKindFromMime } from "../internal/media-kind.js";
import { fileStem } from "./stem.js";
import type {
  AuthoredManifest,
  AuthoredManifestAsset,
  FlatManifest,
  FlatManifestAsset,
  IndexDefinition,
} from "./types.js";

/**
 * Index definitions owned by normalization and appended to every manifest.
 * Their values are derived per asset in {@link normalizeManifest}.
 */
const BUILTIN_INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  { name: "mimeType", cardinality: "single", required: false, builtin: true },
  { name: "mediaKind", cardinality: "single", required: false, builtin: true },
];

/** Built-in index names reserved against user-defined indexes. */
export const BUILTIN_INDEX_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_INDEX_DEFINITIONS.map((definition) => definition.name),
);

/**
 * Normalizes an authored manifest into the final {@link FlatManifest} staged as a generation.
 *
 * Owns the final manifest invariants:
 * - `expiresAt` (when present) is a valid ISO 8601 timestamp with an explicit offset.
 * - Built-in index definitions (`mimeType`, `mediaKind`) follow the user-defined definitions.
 * - Each asset carries a derived `mediaKind`, a normalized `fileStem` (same rule used by
 *   read-side stem queries), and built-in index values alongside its user-defined indexes.
 *
 * Does not mutate the authored manifest.
 */
export function normalizeManifest(manifest: AuthoredManifest): FlatManifest {
  if (manifest.expiresAt !== undefined) {
    validateExpiration(manifest.expiresAt);
  }

  return {
    snapshotId: manifest.snapshotId,
    retrievedAt: manifest.retrievedAt,
    expiresAt: manifest.expiresAt,
    indexDefinitions: [...manifest.indexDefinitions, ...BUILTIN_INDEX_DEFINITIONS],
    assets: manifest.assets.map((asset) => normalizeAsset(asset)),
  };
}

function normalizeAsset(asset: AuthoredManifestAsset): FlatManifestAsset {
  const mediaKind = mediaKindFromMime(asset.mimeType);

  return {
    ...asset,
    mediaKind,
    fileStem: fileStem(asset.fileName),
    indexes: {
      ...asset.indexes,
      mimeType: asset.mimeType,
      mediaKind,
    },
  };
}

const ISO_8601_OFFSET_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function validateExpiration(expiresAt: string): void {
  if (!ISO_8601_OFFSET_TIMESTAMP.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) {
    throw new StoreValidationError(
      "Store expiresAt must be an ISO 8601 timestamp with a timezone offset or Z suffix.",
    );
  }
}
