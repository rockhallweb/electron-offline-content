import { ManifestValidationError } from "./errors.js";
import { fileStem } from "./stem.js";
import { deriveAssetFileName } from "../internal/asset-file-name.js";
import type {
  JsonValue,
  MediaCacheManifest,
  MediaContentDefinition,
  MediaNamespaceDefinition,
  SyncManifestAsset,
} from "./types.js";

export interface NormalizedAsset extends SyncManifestAsset {
  resolvedVersion: string;
  normalizedFileName: string;
  normalizedFileStem: string;
}

export interface NormalizedItem extends Omit<MediaContentDefinition, "assets"> {
  blobs: Record<string, string>;
  metadata: Record<string, JsonValue>;
  assets: NormalizedAsset[];
}

export interface NormalizedNamespace extends Omit<
  MediaNamespaceDefinition,
  "items"
> {
  label?: string;
  metadata: Record<string, JsonValue>;
  items: NormalizedItem[];
}

/** Normalized manifest: namespaces/items/assets as ordered arrays with injected `key` / `id` fields. */
export interface NormalizedManifest {
  snapshotId?: string;
  retrievedAt?: string;
  expiresAt?: string;
  namespaces: NormalizedNamespace[];
}

export function normalizeManifest(
  manifest: MediaCacheManifest,
): NormalizedManifest {
  const expiresAt = normalizeManifestExpiration(manifest.expiresAt);

  const namespaces = Object.entries(manifest.namespaces).map(
    ([namespaceKey, namespace]) => {
      if (!namespaceKey) {
        throw new ManifestValidationError("Namespace key is required.");
      }

      const items = Object.entries(namespace.items ?? {}).map(
        ([itemId, item]) => {
          if (!itemId) {
            throw new ManifestValidationError(
              `Item ID is required in namespace "${namespaceKey}".`,
            );
          }
          if (!item.version) {
            throw new ManifestValidationError(
              `Item version is required for "${namespaceKey}/${itemId}".`,
            );
          }

          const assets = Object.entries(item.assets ?? {}).map(
            ([assetId, asset]) => {
              if (!assetId) {
                throw new ManifestValidationError(
                  `Asset ID is required for "${namespaceKey}/${itemId}".`,
                );
              }

              const normalizedFileName =
                asset.fileName ?? deriveAssetFileName(asset.source);
              return {
                id: assetId,
                ...asset,
                normalizedFileName,
                normalizedFileStem: fileStem(normalizedFileName),
                resolvedVersion: asset.version ?? item.version,
              };
            },
          );

          return {
            id: itemId,
            version: item.version,
            kind: item.kind,
            title: item.title,
            description: item.description,
            summary: item.summary,
            blobs: item.blobs ?? {},
            metadata: item.metadata ?? {},
            assets,
          };
        },
      );

      return {
        key: namespaceKey,
        label: namespace.label,
        metadata: namespace.metadata ?? {},
        items,
      };
    },
  );

  return {
    snapshotId: manifest.snapshotId,
    retrievedAt: manifest.retrievedAt,
    expiresAt,
    namespaces,
  };
}

const ISO_8601_OFFSET_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeManifestExpiration(
  expiresAt: string | undefined,
): string | undefined {
  if (expiresAt === undefined) {
    return undefined;
  }

  if (
    !ISO_8601_OFFSET_TIMESTAMP.test(expiresAt) ||
    Number.isNaN(Date.parse(expiresAt))
  ) {
    throw new ManifestValidationError(
      "Manifest expiresAt must be an ISO 8601 timestamp with a timezone offset or Z suffix.",
    );
  }

  return expiresAt;
}
