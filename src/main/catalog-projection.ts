import { jsonObjectSchema, parseJsonWithSchema } from "../internal/validation.js";
import type { ResolvedMediaAsset } from "../shared/types.js";
import type { ActiveAssetRow } from "./database.js";

export interface CatalogProjectionOptions {
  devPassthrough: boolean;
  assetBaseUrlOrigin: string | null;
  onWarn?: (contextLabel: string, err: unknown) => void;
}

export function projectResolvedMediaAsset(
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
    url: projectResolvedAssetUrl(row, options),
    metadata,
    indexes,
  };
}

function projectResolvedAssetUrl(row: ActiveAssetRow, options: CatalogProjectionOptions): string {
  if (!options.devPassthrough) {
    return `media://asset/${encodeURIComponent(row.assetKey)}`;
  }

  const origin = options.assetBaseUrlOrigin;
  if (!origin) {
    return row.url;
  }

  try {
    const base = new URL(origin);
    const resolved = new URL(row.url);
    resolved.protocol = base.protocol;
    resolved.hostname = base.hostname;
    resolved.port = base.port;
    return resolved.toString();
  } catch (err) {
    if (options.onWarn) {
      options.onWarn(`asset source for "${row.assetKey}"`, err);
    }
    return row.url;
  }
}
