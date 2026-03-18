import type { PaginationInput, PaginationResult } from "./types.js";
import { cursorPayloadSchema, parseJsonWithSchema } from "../internal/validation.js";

interface DecodedCursor {
  index: number;
}

interface PaginationWindow {
  start: number;
  limit: number;
}

export function decodeCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }

  const parsed = parseJsonWithSchema(
    Buffer.from(cursor, "base64url").toString("utf8"),
    cursorPayloadSchema,
    "pagination cursor",
  ) as DecodedCursor;
  return parsed.index;
}

export function encodeCursor(index: number): string {
  return Buffer.from(JSON.stringify({ index }), "utf8").toString("base64url");
}

export function resolvePaginationWindow(pagination?: PaginationInput): PaginationWindow {
  const start = decodeCursor(pagination?.cursor);
  const limit = Math.max(1, Math.min(pagination?.limit ?? 50, 500));

  return {
    start,
    limit,
  };
}

export function paginateArray<T>(items: T[], pagination?: PaginationInput): PaginationResult<T> {
  const { start, limit } = resolvePaginationWindow(pagination);
  const page = items.slice(start, start + limit);
  const nextIndex = start + page.length;

  return {
    items: page,
    nextCursor: nextIndex < items.length ? encodeCursor(nextIndex) : null,
  };
}
