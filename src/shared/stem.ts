import { basename, extname } from "node:path";

export function normalizeStem(stem: string): string {
  return stem.trim().toLowerCase();
}

export function fileStem(fileName: string): string {
  const name = basename(fileName);
  const ext = extname(name);
  return normalizeStem(ext ? name.slice(0, -ext.length) : name);
}
