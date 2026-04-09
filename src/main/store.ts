import { StoreValidationError } from "../shared/errors.js";
import { deriveAssetFileName } from "../internal/asset-file-name.js";
import { mediaKindFromMime } from "../internal/media-kind.js";
import { hashKey, displayKey, isValidKeyInput, type AssetKeyInput } from "../internal/asset-key.js";
import {
  IndexTag,
  type FlatManifest,
  type FlatManifestAsset,
  type IndexDefinition,
  type JsonValue,
  type MediaAssetInput,
  type MediaRemoteSource,
} from "../shared/types.js";

const MIME_PATTERN = /^\S+\/\S+$/;

const BUILTIN_INDEX_NAMES = new Set(["mimeType", "mediaKind"]);

function fileStem(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}

/**
 * Callable handle returned by {@link MediaStore.defineIndex}. Call it with a value
 * to produce an {@link IndexTag} for use in the `indexes` array of {@link MediaStore.add}:
 *
 * ```ts
 * const gallery = store.defineIndex("gallery");
 * store.add("photo-1", { ..., indexes: [gallery("nature")] });
 * ```
 */
export interface MediaIndex {
  (value: string | string[]): IndexTag;
  readonly indexName: string;
  readonly cardinality: "single" | "multi";
  readonly required: boolean;
}

/** Options for {@link createMediaStore}. */
export interface MediaStoreOptions {
  /** Optional opaque id for correlation, debugging, or multi-source merges. */
  snapshotId?: string;
  /** ISO 8601 timestamp describing when the store payload was built. */
  retrievedAt?: string;
  /**
   * ISO 8601 timestamp after which source URLs must be treated as expired.
   * Sync will fail assets whose download starts after this time.
   */
  expiresAt?: string;
}

interface StoredAsset {
  key: string;
  displayKey: string;
  version: string;
  mimeType: string;
  fileName: string;
  byteLength?: number;
  source: MediaRemoteSource;
  metadata: Record<string, JsonValue>;
  indexes: Record<string, string | string[]>;
}

/**
 * A flat key-value asset store with user-defined secondary indexes.
 *
 * Build a store imperatively inside your `resolveStore` callback:
 *
 * ```ts
 * const store = createMediaStore();
 * const gallery = store.defineIndex("gallery");
 * store.add(["forest", "video"], {
 *   version: "v1",
 *   mimeType: "video/mp4",
 *   source: { url: "https://cdn.example.com/forest.mp4" },
 *   indexes: [gallery("nature")],
 * });
 * ```
 */
export class MediaStore {
  private readonly options: MediaStoreOptions;
  private readonly indexes = new Map<string, IndexDefinition>();
  private readonly assets = new Map<string, StoredAsset>();

  constructor(options?: MediaStoreOptions) {
    this.options = options ?? {};
  }

  /**
   * Register a secondary index that assets can be tagged with and queried by.
   * Must be called before any {@link add} call that references this index.
   *
   * @param name - Unique index name. Must not collide with built-in indexes (`mimeType`, `mediaKind`).
   * @param options - Cardinality (`"single"` or `"multi"`) and whether the index is required on every asset.
   * @returns A callable {@link MediaIndex} handle. Call it with a value to produce an {@link IndexTag}.
   */
  defineIndex(
    name: string,
    options?: { cardinality?: "single" | "multi"; required?: boolean },
  ): MediaIndex {
    if (!name) {
      throw new StoreValidationError("Index name must be a non-empty string.");
    }
    if (BUILTIN_INDEX_NAMES.has(name)) {
      throw new StoreValidationError(`Index name "${name}" is reserved as a built-in index.`);
    }
    if (this.indexes.has(name)) {
      throw new StoreValidationError(`Duplicate index name "${name}".`);
    }

    const cardinality = options?.cardinality ?? "single";
    const required = options?.required ?? false;

    if (cardinality !== "single" && cardinality !== "multi") {
      throw new StoreValidationError(
        `Index "${name}": cardinality must be "single" or "multi" (got "${String(cardinality)}").`,
      );
    }
    if (typeof required !== "boolean") {
      throw new StoreValidationError(
        `Index "${name}": required must be a boolean (got ${typeof required}).`,
      );
    }

    this.indexes.set(name, { name, cardinality, required, builtin: false });

    const fn = (value: string | string[]) => new IndexTag(name, value);
    Object.defineProperties(fn, {
      indexName: { value: name, enumerable: true },
      cardinality: { value: cardinality, enumerable: true },
      required: { value: required, enumerable: true },
    });
    return fn as MediaIndex;
  }

  /**
   * Add an asset to the store.
   *
   * @param key - Unique asset key. A string or array of string segments (e.g. `["videos", "hubble", "main"]`).
   * @param input - Asset data: version, mimeType, source, and optional indexes/metadata.
   */
  add(key: AssetKeyInput, input: MediaAssetInput): void {
    if (!isValidKeyInput(key)) {
      throw new StoreValidationError(
        "Asset key must be a non-empty string or non-empty string array.",
      );
    }
    const hashedKey = hashKey(key);
    const display = displayKey(key);
    if (this.assets.has(hashedKey)) {
      throw new StoreValidationError(
        `Duplicate asset key "${display}" (hash collision with existing key).`,
      );
    }

    if (!input.version) {
      throw new StoreValidationError(`Asset "${display}": version is required.`);
    }
    if (!input.mimeType || !MIME_PATTERN.test(input.mimeType)) {
      throw new StoreValidationError(
        `Asset "${display}": mimeType must be a valid type/subtype string (got "${input.mimeType ?? ""}").`,
      );
    }
    if (!input.source?.url) {
      throw new StoreValidationError(`Asset "${display}": source.url is required.`);
    }
    if (input.source.method !== undefined && input.source.method !== "GET") {
      throw new StoreValidationError(
        `Asset "${display}": source.method must be GET (got "${input.source.method}").`,
      );
    }
    try {
      const parsed = new URL(input.source.url);
      if (!/^https?:$/i.test(parsed.protocol)) {
        throw new StoreValidationError(
          `Asset "${display}": source URL must use http or https (got "${parsed.protocol}").`,
        );
      }
    } catch (err) {
      if (err instanceof StoreValidationError) throw err;
      throw new StoreValidationError(
        `Asset "${display}": source URL is not valid: "${input.source.url}".`,
      );
    }

    if (
      input.byteLength !== undefined &&
      (typeof input.byteLength !== "number" ||
        !Number.isFinite(input.byteLength) ||
        input.byteLength < 0)
    ) {
      throw new StoreValidationError(
        `Asset "${display}": byteLength must be a non-negative finite number (got ${String(input.byteLength)}).`,
      );
    }

    const fileName = input.fileName ?? deriveAssetFileName(input.source);

    const assetIndexes: Record<string, string | string[]> = Object.create(null);
    if (input.indexes) {
      for (const tag of input.indexes) {
        if (!(tag instanceof IndexTag)) {
          throw new StoreValidationError(
            `Asset "${display}": indexes must be an array of IndexTag entries produced by calling a defineIndex handle.`,
          );
        }
        const indexName = tag.name;
        const value = tag.value;
        const def = this.indexes.get(indexName);
        if (!def) {
          throw new StoreValidationError(
            `Asset "${display}": index "${indexName}" has not been defined. Call store.defineIndex("${indexName}") first.`,
          );
        }
        if (indexName in assetIndexes) {
          throw new StoreValidationError(
            `Asset "${display}": duplicate index "${indexName}" in indexes array.`,
          );
        }

        if (def.cardinality === "single") {
          if (Array.isArray(value)) {
            throw new StoreValidationError(
              `Asset "${display}": index "${indexName}" has single cardinality but received an array. ` +
                `Use { cardinality: "multi" } when defining the index to allow arrays.`,
            );
          }
          if (typeof value !== "string" || !value) {
            throw new StoreValidationError(
              `Asset "${display}": index "${indexName}" value must be a non-empty string.`,
            );
          }
          assetIndexes[indexName] = value;
        } else {
          const values = Array.isArray(value) ? value : [value];
          if (values.length === 0) {
            throw new StoreValidationError(
              `Asset "${display}": index "${indexName}" value array must not be empty.`,
            );
          }
          for (const v of values) {
            if (typeof v !== "string" || !v) {
              throw new StoreValidationError(
                `Asset "${display}": index "${indexName}" values must be non-empty strings.`,
              );
            }
          }
          assetIndexes[indexName] = values;
        }
      }
    }

    this.assets.set(hashedKey, {
      key: hashedKey,
      displayKey: display,
      version: input.version,
      mimeType: input.mimeType,
      fileName,
      byteLength: input.byteLength,
      source: {
        url: input.source.url,
        ...(input.source.method ? { method: input.source.method } : {}),
        ...(input.source.headers ? { headers: input.source.headers } : {}),
      },
      metadata: input.metadata ?? {},
      indexes: assetIndexes,
    });
  }

  /**
   * Serialize the store for the sync engine. Validates required indexes and produces
   * the flat manifest consumed internally. Not part of the public consumer API.
   * @internal
   */
  _serialize(): FlatManifest {
    for (const [, def] of this.indexes) {
      if (!def.required) continue;
      for (const [, asset] of this.assets) {
        if (!(def.name in asset.indexes)) {
          throw new StoreValidationError(
            `Asset "${asset.displayKey}": required index "${def.name}" is missing.`,
          );
        }
      }
    }

    const indexDefinitions: IndexDefinition[] = [
      ...Array.from(this.indexes.values()),
      { name: "mimeType", cardinality: "single", required: false, builtin: true },
      { name: "mediaKind", cardinality: "single", required: false, builtin: true },
    ];

    const assets: FlatManifestAsset[] = [];
    for (const [, stored] of this.assets) {
      const mediaKind = mediaKindFromMime(stored.mimeType);
      const stem = fileStem(stored.fileName);

      const allIndexes: Record<string, string | string[]> = {
        ...stored.indexes,
        mimeType: stored.mimeType,
        mediaKind,
      };

      assets.push({
        key: stored.key,
        displayKey: stored.displayKey,
        version: stored.version,
        mimeType: stored.mimeType,
        mediaKind,
        fileName: stored.fileName,
        fileStem: stem,
        byteLength: stored.byteLength,
        source: stored.source,
        metadata: stored.metadata,
        indexes: allIndexes,
      });
    }

    return {
      snapshotId: this.options.snapshotId,
      retrievedAt: this.options.retrievedAt,
      expiresAt: this.options.expiresAt,
      indexDefinitions,
      assets,
    };
  }
}

/** Creates a new {@link MediaStore} for populating in a `resolveStore` callback. */
export function createMediaStore(options?: MediaStoreOptions): MediaStore {
  return new MediaStore(options);
}
