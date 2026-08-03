import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { Session } from "electron";

/** Committed catalog target for one `media://asset/<key>` request. */
export interface MediaProtocolAssetTarget {
  /** Absolute path of the committed blob, or null when the catalog row has no local file. */
  absolutePath: string | null;
}

/** Debug sink for `media:` request lifecycle events emitted by the adapter. */
export type MediaProtocolDebugLog = (event: string, fields: Record<string, string | null>) => void;

/** Options for {@link createMediaProtocolHandler} / {@link registerMediaProtocolHandler}. */
export interface MediaProtocolHandlerOptions {
  /** Looks up the committed catalog target for a decoded asset key (null when unknown). */
  resolveAssetTarget: (assetKey: string) => MediaProtocolAssetTarget | null;
  /** Custom file-serving handler; receives the protocol request and resolved local path. */
  fetchFile?: (request: Request, filePath: string) => Promise<Response>;
  /** Optional debug sink for request lifecycle events. */
  onDebugLog?: MediaProtocolDebugLog;
}

/**
 * Builds the `media:` protocol request handler. The adapter owns `media://asset/<key>` URL
 * parsing, catalog lookup behavior, local file response creation (full, HEAD, and byte-range
 * responses with MIME inference), and 404 responses for unknown assets or missing blobs.
 */
export function createMediaProtocolHandler(
  options: MediaProtocolHandlerOptions,
): (request: Request) => Promise<Response> {
  const fetchFile =
    options.fetchFile ??
    (async (request: Request, filePath: string) => createMediaFileResponse(filePath, request));
  const onDebugLog = options.onDebugLog ?? (() => undefined);

  return async (request) => {
    const parsed = new URL(request.url);
    const parts = parsed.pathname.split("/").filter(Boolean);

    if (parsed.hostname !== "asset" || parts.length !== 1) {
      return new Response("Not found", { status: 404 });
    }

    let assetKey: string;
    try {
      assetKey = decodeURIComponent(parts[0]);
    } catch {
      return new Response("Not found", { status: 404 });
    }

    const target = options.resolveAssetTarget(assetKey);

    if (!target) {
      onDebugLog("protocol_request_not_found", {
        asset_key: assetKey,
        method: request.method,
      });
      return new Response("Not found", { status: 404 });
    }

    if (!target.absolutePath || !existsSync(target.absolutePath)) {
      onDebugLog("protocol_request_file_missing", {
        asset_key: assetKey,
        method: request.method,
      });
      return new Response("Not found", { status: 404 });
    }

    onDebugLog("protocol_request_local_resolved", {
      asset_key: assetKey,
      method: request.method,
      range: request.headers.get("range"),
    });
    return fetchFile(request, target.absolutePath);
  };
}

/** Registers the handler built by {@link createMediaProtocolHandler} for the `media:` scheme. */
export function registerMediaProtocolHandler(
  session: Session,
  options: MediaProtocolHandlerOptions,
): void {
  session.protocol.handle("media", createMediaProtocolHandler(options));
}

/**
 * Serves one committed blob: full responses, HEAD responses with content-length only, and
 * single byte-range responses (206 with `content-range`, 416 when unsatisfiable).
 */
function createMediaFileResponse(filePath: string, request: Request): Response {
  const stats = statSync(filePath);
  const size = stats.size;
  const rangeHeader = request.headers.get("range");
  const mimeType = inferMimeType(filePath);
  const baseHeaders = new Headers({
    "accept-ranges": "bytes",
    "content-type": mimeType,
  });

  if (request.method === "HEAD") {
    baseHeaders.set("content-length", String(size));
    return new Response(null, {
      status: 200,
      headers: baseHeaders,
    });
  }

  if (!rangeHeader) {
    return createFullMediaFileResponse(filePath, size, baseHeaders);
  }

  const parsedRange = parseByteRange(rangeHeader, size);
  // Malformed Range headers are treated as absent (RFC 9110 §14) — serve the full entity.
  if (parsedRange === "ignore") {
    return createFullMediaFileResponse(filePath, size, baseHeaders);
  }
  if (!parsedRange) {
    baseHeaders.set("content-range", `bytes */${size}`);
    return new Response(null, {
      status: 416,
      headers: baseHeaders,
    });
  }

  const { start, end } = parsedRange;
  const chunkLength = end - start + 1;
  baseHeaders.set("content-length", String(chunkLength));
  baseHeaders.set("content-range", `bytes ${start}-${end}/${size}`);
  return new Response(Readable.toWeb(createReadStream(filePath, { start, end })) as BodyInit, {
    status: 206,
    headers: baseHeaders,
  });
}

function createFullMediaFileResponse(
  filePath: string,
  size: number,
  baseHeaders: Headers,
): Response {
  baseHeaders.set("content-length", String(size));
  return new Response(Readable.toWeb(createReadStream(filePath)) as BodyInit, {
    status: 200,
    headers: baseHeaders,
  });
}

/**
 * Parses a single `bytes=` Range value.
 *
 * Returns:
 * - `{ start, end }` for a satisfiable range
 * - `null` for a well-formed but unsatisfiable / unsupported range (caller should 416)
 * - `"ignore"` for a malformed specifier (caller should treat the header as absent)
 *
 * Digit fields must be entirely numeric — no `Number.parseInt` prefix parsing
 * (e.g. `bytes=1x-4` is ignored, not treated as `1-4`).
 */
function parseByteRange(
  rangeHeader: string,
  size: number,
): { start: number; end: number } | "ignore" | null {
  if (!rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const value = rangeHeader.slice("bytes=".length).trim();
  if (value.length === 0 || value.includes(",")) {
    return null;
  }

  // suffix-byte-range-spec: "-" 1*DIGIT
  if (value.startsWith("-")) {
    const suffixText = value.slice(1);
    if (!isStrictDigitString(suffixText)) {
      return "ignore";
    }
    const suffixLength = Number.parseInt(suffixText, 10);
    if (suffixLength <= 0) {
      return null;
    }
    const start = Math.max(size - suffixLength, 0);
    const end = size - 1;
    return start <= end ? { start, end } : null;
  }

  // byte-range-spec: 1*DIGIT "-" [ 1*DIGIT ]
  const separatorIndex = value.indexOf("-");
  if (separatorIndex <= 0 || value.indexOf("-", separatorIndex + 1) !== -1) {
    return "ignore";
  }

  const startText = value.slice(0, separatorIndex);
  const endText = value.slice(separatorIndex + 1);
  if (!isStrictDigitString(startText) || (endText !== "" && !isStrictDigitString(endText))) {
    return "ignore";
  }

  const start = Number.parseInt(startText, 10);
  const end = endText === "" ? size - 1 : Number.parseInt(endText, 10);
  if (end < start || start >= size) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

function isStrictDigitString(value: string): boolean {
  return value.length > 0 && /^\d+$/.test(value);
}

function inferMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".mp4")) {
    return "video/mp4";
  }
  if (lower.endsWith(".webm")) {
    return "video/webm";
  }
  if (lower.endsWith(".mov")) {
    return "video/quicktime";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".vtt")) {
    return "text/vtt";
  }
  if (lower.endsWith(".srt")) {
    return "application/x-subrip";
  }
  if (lower.endsWith(".mp3")) {
    return "audio/mpeg";
  }
  if (lower.endsWith(".wav")) {
    return "audio/wav";
  }
  if (lower.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (lower.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }
  if (lower.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  return "application/octet-stream";
}
