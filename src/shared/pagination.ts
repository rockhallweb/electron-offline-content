import type { PaginationInput, PaginationResult } from "./types.js";

interface DecodedCursor {
  index: number;
}

export function decodeCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }

  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as DecodedCursor;
  return parsed.index;
}

export function encodeCursor(index: number): string {
  return Buffer.from(JSON.stringify({ index }), "utf8").toString("base64url");
}

export function paginateArray<T>(items: T[], pagination?: PaginationInput): PaginationResult<T> {
  const start = decodeCursor(pagination?.cursor);
  const limit = Math.max(1, Math.min(pagination?.limit ?? 50, 500));
  const page = items.slice(start, start + limit);
  const nextIndex = start + page.length;

  return {
    items: page,
    nextCursor: nextIndex < items.length ? encodeCursor(nextIndex) : null,
  };
}
