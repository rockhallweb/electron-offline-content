import { basename, extname } from "node:path";

/**
 * The single stem normalization rule shared by the write side (manifest normalization)
 * and the read side (`findByFileStem` query input).
 */
export function normalizeStem(stem: string): string {
  return stem.trim().toLowerCase();
}

/** Derives the normalized file stem stored on each manifest asset from its file name. */
export function fileStem(fileName: string): string {
  const name = basename(fileName);
  const ext = extname(name);
  return normalizeStem(ext ? name.slice(0, -ext.length) : name);
}
