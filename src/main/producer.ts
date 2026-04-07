import { normalizeManifest } from "../shared/normalize.js";
import { ManifestValidationError } from "../shared/errors.js";
import type {
  MediaAssetValue,
  MediaCacheManifest,
  MediaItemValue,
  MediaNamespaceValue,
} from "../shared/types.js";
import { deriveAssetFileName } from "../internal/asset-file-name.js";
import {
  mediaAssetValueSchema,
  mediaCacheManifestSchema,
  mediaItemValueSchema,
  mediaNamespaceValueSchema,
  parseWithSchema,
} from "../internal/validation.js";
import { z } from "zod";

/**
 * Validates and returns a producer manifest.
 *
 * This helper is a type-safe chokepoint for manifest authoring:
 * - validates manifest shape with Zod
 * - runs internal semantic normalization checks (file-name derivation, etc.)
 * - returns the parsed manifest unchanged
 */
export function defineManifest(input: MediaCacheManifest): MediaCacheManifest {
  const manifest = parseWithSchema(mediaCacheManifestSchema, input, "manifest definition");
  void normalizeManifest(manifest);
  return manifest;
}

/**
 * Validates a manifest item value against the schema and returns it unchanged.
 * Object keys for the item id live on the parent `items` record, not on this value.
 *
 * @param input - One catalog item: `version`, `kind`, optional text and `blobs` / `metadata`, and `assets` record.
 */
export function defineItem(input: MediaItemValue): MediaItemValue {
  return parseWithSchema(mediaItemValueSchema, input, "manifest item definition");
}

/** Validates, derives `fileName` from the source URL when absent, and returns the asset value. */
export function defineAsset(input: MediaAssetValue): MediaAssetValue {
  const asset = parseWithSchema(mediaAssetValueSchema, input, "manifest asset definition");
  if (asset.fileName) {
    return asset;
  }

  return {
    ...asset,
    fileName: deriveAssetFileName(asset.source),
  };
}

/**
 * Builds a record from entries, validating each value and rejecting empty or duplicate keys.
 */
function fromEntriesWithValidation<T, TValue>(
  source: readonly T[],
  fn: (element: T, index: number) => readonly [string, TValue],
  schema: z.ZodType<TValue>,
  options: {
    builderName: string;
    entityName: string;
    keyLabel: string;
  },
): Record<string, TValue> {
  const out: Record<string, TValue> = {};
  const keyToFirstIndex = new Map<string, number>();

  for (let i = 0; i < source.length; i++) {
    const tuple = fn(source[i]!, i);
    const key = tuple[0];
    const value = tuple[1];
    if (!key) {
      throw new ManifestValidationError(
        `${options.builderName}: empty ${options.entityName} ${options.keyLabel} at index ${i}.`,
      );
    }
    const first = keyToFirstIndex.get(key);
    if (first !== undefined) {
      throw new ManifestValidationError(
        `Duplicate ${options.entityName} ${options.keyLabel} "${key}" in ${options.builderName}() — first seen at index ${first}, duplicate at index ${i}.`,
      );
    }
    keyToFirstIndex.set(key, i);
    out[key] = parseWithSchema(
      schema,
      value,
      `${options.builderName} index ${i} (${options.keyLabel} "${key}")`,
    );
  }

  return out;
}

/**
 * Builds a `namespaces` record from an array, validating each value and rejecting duplicate keys.
 */
export function namespacesFromEntries<T>(
  source: readonly T[],
  fn: (element: T, index: number) => readonly [string, MediaNamespaceValue],
): Record<string, MediaNamespaceValue> {
  return fromEntriesWithValidation(source, fn, mediaNamespaceValueSchema, {
    builderName: "namespacesFromEntries",
    entityName: "namespace",
    keyLabel: "key",
  });
}

/**
 * Builds an `items` record from an array, validating each value and rejecting duplicate keys.
 */
export function itemsFromEntries<T>(
  source: readonly T[],
  fn: (element: T, index: number) => readonly [string, MediaItemValue],
): Record<string, MediaItemValue> {
  return fromEntriesWithValidation(source, fn, mediaItemValueSchema, {
    builderName: "itemsFromEntries",
    entityName: "item",
    keyLabel: "id",
  });
}

/**
 * Builds an `assets` record from an array, validating each value and rejecting duplicate keys.
 */
export function assetsFromEntries<T>(
  source: readonly T[],
  fn: (element: T, index: number) => readonly [string, MediaAssetValue],
): Record<string, MediaAssetValue> {
  return fromEntriesWithValidation(source, fn, mediaAssetValueSchema, {
    builderName: "assetsFromEntries",
    entityName: "asset",
    keyLabel: "id",
  });
}
