import { StoreValidationError } from "../shared/errors.js";

/** Derives a file name from the asset URL path. */
export function deriveAssetFileName(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname ?? "";
  const segments = path.split("/").filter(Boolean);
  const candidate = segments.at(-1);
  if (!candidate) {
    throw new StoreValidationError(
      `Asset URL "${url}" must include a filename in the path, or set an explicit "fileName" on the asset.`,
    );
  }

  return decodeURIComponent(candidate);
}
