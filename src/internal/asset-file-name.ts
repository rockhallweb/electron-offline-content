import { ManifestValidationError } from "../shared/errors.js";
import type { MediaRemoteSource } from "../shared/types.js";

/** Derives a file name from the manifest source URL path. */
export function deriveAssetFileName(source: MediaRemoteSource): string {
  const parsed = new URL(source.url);
  const path = parsed.pathname ?? "";
  const segments = path.split("/").filter(Boolean);
  const candidate = segments.at(-1);
  if (!candidate) {
    throw new ManifestValidationError(
      `Asset source URL "${source.url}" must include a filename in the path, or set an explicit "fileName" on the asset.`,
    );
  }

  return decodeURIComponent(candidate);
}
