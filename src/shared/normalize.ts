import { ManifestValidationError } from "./errors.js";
import { fileStem } from "./stem.js";
import type {
  DownloadRequest,
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

        const normalizedFileName = asset.fileName ?? deriveFileName(asset.source);
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
    generatedAt: manifest.generatedAt,
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

function deriveFileName(source: DownloadRequest): string {
  const parsed = new URL(source.url);
  const path = parsed.pathname ?? "";
  const segments = path.split("/").filter(Boolean);
  const candidate = segments.at(-1);
  if (!candidate) {
    throw new ManifestValidationError(
      `Asset source URL "${source.url}" must include a filename or explicit fileName.`,
    );
  }

  return decodeURIComponent(candidate);
}
