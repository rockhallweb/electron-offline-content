/** Canonicalizes persisted Blob paths so identity comparisons are platform-independent. */
export function normalizeStoredRelativePath(relativePath: string): string {
  return relativePath.split(/[\\/]/).join("/");
}
