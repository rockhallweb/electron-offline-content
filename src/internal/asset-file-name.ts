import { ManifestValidationError } from "../shared/errors.js";
import type { DownloadRequest } from "../shared/types.js";

/** Derives a file name from the request URL path. Throws when the URL has no final path segment. */
export function deriveAssetFileName(source: DownloadRequest): string {
  const parsed = new URL(source.url);
  const path = parsed.pathname ?? "";
  const segments = path.split("/").filter(Boolean);
  const candidate = segments.at(-1);
  if (!candidate) {
    throw new ManifestValidationError(
      `Asset source URL "${source.url}" must include a filename in the path.`,
    );
  }

  return decodeURIComponent(candidate);
}
