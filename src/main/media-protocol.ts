import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { JsonValue, MediaCacheLogLevel } from "../shared/types.js";

export type MediaProtocolLogHandler = (
  level: MediaCacheLogLevel,
  event: string,
  fields?: Record<string, JsonValue | undefined>,
) => void;

export interface MediaProtocolAssetCatalog {
  getProtocolAssetTarget(assetKey: string): { absolutePath: string | null } | null;
}

export interface MediaProtocolOptions {
  catalog: MediaProtocolAssetCatalog;
  fetchFile?: (request: Request, filePath: string) => Promise<Response>;
  emitLog: MediaProtocolLogHandler;
}

export function createMediaProtocolHandler(options: MediaProtocolOptions) {
  const fetchFile =
    options.fetchFile ?? (async (request, filePath) => createFileResponse(filePath, request));

  return async (request: Request): Promise<Response> => {
    const assetKey = parseMediaAssetKey(request.url);
    if (assetKey === null) {
      return new Response("Not found", { status: 404 });
    }

    const target = options.catalog.getProtocolAssetTarget(assetKey);

    if (!target) {
      options.emitLog("debug", "protocol_request_not_found", {
        asset_key: assetKey,
        method: request.method,
      });
      return new Response("Not found", { status: 404 });
    }

    if (!target.absolutePath || !existsSync(target.absolutePath)) {
      options.emitLog("debug", "protocol_request_file_missing", {
        asset_key: assetKey,
        method: request.method,
      });
      return new Response("Not found", { status: 404 });
    }

    options.emitLog("debug", "protocol_request_local_resolved", {
      asset_key: assetKey,
      method: request.method,
      range: request.headers.get("range"),
    });
    return fetchFile(request, target.absolutePath);
  };
}

function parseMediaAssetKey(url: string): string | null {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);

  if (parsed.hostname !== "asset" || parts.length !== 1) {
    return null;
  }

  try {
    return decodeURIComponent(parts[0]!);
  } catch {
    return null;
  }
}

function createFileResponse(filePath: string, request: Request): Response {
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
    baseHeaders.set("content-length", String(size));
    return new Response(Readable.toWeb(createReadStream(filePath)) as BodyInit, {
      status: 200,
      headers: baseHeaders,
    });
  }

  const parsedRange = parseByteRange(rangeHeader, size);
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

function parseByteRange(rangeHeader: string, size: number): { start: number; end: number } | null {
  if (!rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const value = rangeHeader.slice("bytes=".length).trim();
  if (value.length === 0 || value.includes(",")) {
    return null;
  }

  const [startText, endText] = value.split("-", 2);
  if (startText === undefined || endText === undefined) {
    return null;
  }

  if (startText === "") {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    const start = Math.max(size - suffixLength, 0);
    const end = size - 1;
    return start <= end ? { start, end } : null;
  }

  const start = Number.parseInt(startText, 10);
  const end = endText === "" ? size - 1 : Number.parseInt(endText, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  if (start < 0 || end < start || start >= size) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
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
