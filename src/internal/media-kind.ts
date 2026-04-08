import type { MediaKind } from "../shared/types.js";

const documentMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "application/epub+zip",
]);

/**
 * Derives a coarse {@link MediaKind} from a MIME type string.
 *
 * Mapping rules (first match wins):
 * - `video/*` → `"video"`
 * - `image/*` → `"image"`
 * - `audio/*` → `"audio"`
 * - `text/html` → `"html"`
 * - `text/*` → `"text"`
 * - Known document MIME types (PDF, Office, EPUB) → `"document"`
 * - `application/json` → `"text"`
 * - Everything else → `"binary"`
 */
export function mediaKindFromMime(mime: string): MediaKind {
  const normalized = mime.trim().toLowerCase().split(";")[0]!.trim();
  const slash = normalized.indexOf("/");
  if (slash === -1) {
    return "binary";
  }

  const type = normalized.slice(0, slash);

  switch (type) {
    case "video":
      return "video";
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "text":
      return normalized === "text/html" ? "html" : "text";
    case "application":
      if (documentMimeTypes.has(normalized)) {
        return "document";
      }
      if (normalized === "application/json") {
        return "text";
      }
      return "binary";
    default:
      return "binary";
  }
}
