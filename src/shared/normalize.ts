import { ManifestValidationError } from "./errors.js";
import { fileStem } from "./stem.js";
import { deriveAssetFileName } from "../internal/asset-file-name.js";
import type {
  JsonValue,
  ManifestInput,
  MediaAssetDefinition,
  MediaCacheManifest,
  MediaContentDefinition,
  MediaNamespaceDefinition,
} from "./types.js";

export interface NormalizedAsset extends MediaAssetDefinition {
  resolvedVersion: string;
  normalizedFileName: string;
  normalizedFileStem: string;
}

export interface NormalizedItem extends Omit<MediaContentDefinition, "assets"> {
  blobs: Record<string, string>;
  metadata: Record<string, JsonValue>;
  assets: NormalizedAsset[];
}

export interface NormalizedNamespace extends Omit<MediaNamespaceDefinition, "items"> {
  label?: string;
  metadata: Record<string, JsonValue>;
  items: NormalizedItem[];
}

export interface NormalizedManifest extends MediaCacheManifest {
  namespaces: NormalizedNamespace[];
}

export function normalizeManifest(input: ManifestInput): NormalizedManifest {
  const manifest = toManifest(input);
  const expiresAt = normalizeManifestExpiration(manifest.expiresAt);
  const namespaceSeen = new Set<string>();

  const namespaces = manifest.namespaces.map((namespace) => {
    if (!namespace.key) {
      throw new ManifestValidationError("Namespace key is required.");
    }

    if (namespaceSeen.has(namespace.key)) {
      throw new ManifestValidationError(`Duplicate namespace key "${namespace.key}".`);
    }
    namespaceSeen.add(namespace.key);

    const itemSeen = new Set<string>();
    const items = namespace.items.map((item) => {
      if (!item.id) {
        throw new ManifestValidationError(`Item ID is required in namespace "${namespace.key}".`);
      }
      if (!item.version) {
        throw new ManifestValidationError(
          `Item version is required for "${namespace.key}/${item.id}".`,
        );
      }
      if (itemSeen.has(item.id)) {
        throw new ManifestValidationError(
          `Duplicate item ID "${item.id}" in namespace "${namespace.key}".`,
        );
      }
      itemSeen.add(item.id);

      const assetSeen = new Set<string>();
      const assets = item.assets.map((asset) => {
        if (!asset.id) {
          throw new ManifestValidationError(
            `Asset ID is required for "${namespace.key}/${item.id}".`,
          );
        }
        if (assetSeen.has(asset.id)) {
          throw new ManifestValidationError(
            `Duplicate asset ID "${asset.id}" in "${namespace.key}/${item.id}".`,
          );
        }
        assetSeen.add(asset.id);

        const normalizedFileName = asset.fileName ?? deriveAssetFileName(asset.source);
        return {
          ...asset,
          normalizedFileName,
          normalizedFileStem: fileStem(normalizedFileName),
          resolvedVersion: asset.version ?? item.version,
        };
      });

      return {
        ...item,
        blobs: item.blobs ?? {},
        metadata: item.metadata ?? {},
        assets,
      };
    });

    return {
      ...namespace,
      metadata: namespace.metadata ?? {},
      items,
    };
  });

  return {
    snapshotId: manifest.snapshotId,
    retrievedAt: manifest.retrievedAt,
    expiresAt,
    namespaces,
  };
}

function toManifest(input: ManifestInput): MediaCacheManifest {
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return { namespaces: [] };
    }

    const first = input[0] as MediaNamespaceDefinition | MediaContentDefinition;
    if ("items" in first) {
      return { namespaces: input as MediaNamespaceDefinition[] };
    }

    return {
      namespaces: [
        {
          key: "default",
          items: input as MediaContentDefinition[],
        },
      ],
    };
  }

  return input;
}

const ISO_8601_OFFSET_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeManifestExpiration(expiresAt: string | undefined): string | undefined {
  if (expiresAt === undefined) {
    return undefined;
  }

  if (!ISO_8601_OFFSET_TIMESTAMP.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) {
    throw new ManifestValidationError(
      "Manifest expiresAt must be an ISO 8601 timestamp with a timezone offset or Z suffix.",
    );
  }

  return expiresAt;
}
