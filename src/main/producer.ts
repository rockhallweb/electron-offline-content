import { normalizeManifest } from "../shared/normalize.js";
import type { ManifestAsset, ManifestItem, MediaCacheManifest } from "../shared/types.js";
import { deriveAssetFileName } from "../internal/asset-file-name.js";
import {
  mediaAssetDefinitionSchema,
  mediaCacheManifestSchema,
  mediaContentDefinitionSchema,
  parseWithSchema,
} from "../internal/validation.js";

/**
 * Validates and returns a producer manifest.
 *
 * This helper is a type-safe chokepoint for manifest authoring:
 * - validates manifest shape with Zod
 * - runs internal semantic normalization checks (duplicates, file-name derivation, etc.)
 * - returns the parsed manifest unchanged (unlike {@link defineManifestAsset}, no enrichment)
 */
export function defineManifest(input: MediaCacheManifest): MediaCacheManifest {
  const manifest = parseWithSchema(mediaCacheManifestSchema, input, "manifest definition");
  // Validate semantic invariants (duplicate keys, file-name derivability); result intentionally discarded.
  void normalizeManifest(manifest);
  return manifest;
}

/**
 * Validates a manifest item against the schema and returns it unchanged.
 *
 * Object literal keys are documented on {@link ManifestItem} (`MediaContentDefinition`) for IDE hover.
 *
 * @param input - One catalog item: `id`, `version`, `kind`, optional text and `blobs` / `metadata`, and `assets`.
 */
export function defineManifestItem(input: ManifestItem): ManifestItem {
  return parseWithSchema(mediaContentDefinitionSchema, input, "manifest item definition");
}

/** Validates and returns one producer manifest asset definition. */
export function defineManifestAsset(input: ManifestAsset): ManifestAsset {
  const asset = parseWithSchema(mediaAssetDefinitionSchema, input, "manifest asset definition");
  if (asset.fileName) {
    return asset;
  }

  return {
    ...asset,
    fileName: deriveAssetFileName(asset.source),
  };
}
