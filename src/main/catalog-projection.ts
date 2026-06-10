import type { ResolvedMediaAsset } from "../shared/types.js";
import { jsonObjectSchema, parseJsonWithSchema } from "../internal/validation.js";
import type { ActiveAssetRow } from "./database.js";

export interface CatalogProjectionOptions {
  devPassthrough: boolean;
  assetBaseUrlOrigin: string | null;
  /**
   * Invoked only when dev passthrough origin override fails (fallback to stored URL).
   * Not called for invalid `url` (parse error) — those throw.
   */
  onWarn?: (contextLabel: string, err: unknown) => void;
}

/**
 * Projects a validated catalog row into a ResolvedMediaAsset, applying URL policy:
 * offline `media://` URLs by default, or the stored source URL (optionally rewritten
 * to the assetBaseUrl origin) when dev passthrough is enabled.
 */
export function projectResolvedAsset(
  row: ActiveAssetRow,
  options: CatalogProjectionOptions,
): ResolvedMediaAsset {
  const metadata = parseJsonWithSchema(
    row.metadata,
    jsonObjectSchema,
    `metadata for asset "${row.assetKey}"`,
  );
  const indexes = parseJsonWithSchema(
    row.indexesJson,
    jsonObjectSchema,
    `indexes for asset "${row.assetKey}"`,
  ) as Record<string, string | string[]>;

  return {
    key: row.assetKey,
    displayKey: row.displayKey,
    version: row.version,
    mimeType: row.mimeType,
    kind: row.mediaKind,
    byteLength: row.byteLength ?? undefined,
    url: resolveAssetUrl(row, options),
    metadata,
    indexes,
  };
}

function resolveAssetUrl(row: ActiveAssetRow, options: CatalogProjectionOptions): string {
  if (!options.devPassthrough) {
    return `media://asset/${encodeURIComponent(row.assetKey)}`;
  }

  let url = row.url;
  const origin = options.assetBaseUrlOrigin;
  if (origin) {
    try {
      const base = new URL(origin);
      const resolved = new URL(url);
      resolved.protocol = base.protocol;
      resolved.hostname = base.hostname;
      resolved.port = base.port;
      url = resolved.toString();
    } catch (err) {
      if (options.onWarn) {
        options.onWarn(`asset source for "${row.assetKey}"`, err);
      }
    }
  }
  return url;
}
