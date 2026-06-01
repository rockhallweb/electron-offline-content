import { StoreValidationError } from "./errors.js";
import { mediaKindFromMime } from "../internal/media-kind.js";
import { fileStem } from "./stem.js";
import type { FlatManifest, IndexDefinition, JsonValue, MediaKind } from "./types.js";

export interface NormalizableManifestAsset {
  key: string;
  displayKey: string;
  version: string;
  mimeType: string;
  url: string;
  fileName: string;
  byteLength?: number;
  metadata: Record<string, JsonValue>;
  indexes: Record<string, string | string[]>;
}

export interface NormalizableManifest {
  snapshotId?: string;
  retrievedAt?: string;
  expiresAt?: string;
  indexDefinitions: IndexDefinition[];
  assets: NormalizableManifestAsset[];
}

const BUILTIN_INDEX_DEFINITIONS: IndexDefinition[] = [
  { name: "mimeType", cardinality: "single", required: false, builtin: true },
  { name: "mediaKind", cardinality: "single", required: false, builtin: true },
];

/**
 * Normalizes and validates the final manifest shape consumed by sync staging.
 */
export function normalizeFlatManifest(input: NormalizableManifest): FlatManifest {
  const manifest: FlatManifest = {
    snapshotId: input.snapshotId,
    retrievedAt: input.retrievedAt,
    expiresAt: input.expiresAt,
    indexDefinitions: [...input.indexDefinitions, ...BUILTIN_INDEX_DEFINITIONS],
    assets: input.assets.map((asset) => {
      const mediaKind: MediaKind = mediaKindFromMime(asset.mimeType);
      return {
        key: asset.key,
        displayKey: asset.displayKey,
        version: asset.version,
        mimeType: asset.mimeType,
        mediaKind,
        url: asset.url,
        fileName: asset.fileName,
        fileStem: fileStem(asset.fileName),
        byteLength: asset.byteLength,
        metadata: asset.metadata,
        indexes: {
          ...asset.indexes,
          mimeType: asset.mimeType,
          mediaKind,
        },
      };
    }),
  };

  return validateFlatManifest(manifest);
}

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
