/**
 * Emergency fallback when no onWarn/onLog is available — writes to console.warn.
 * Only used when MediaCacheDatabase is constructed without onWarn, or MediaCache
 * has no onLog (e.g. direct DB usage, minimal tests).
 */
export function consoleWarnResolveAssetBaseUrlFallback(contextLabel: string, err: unknown): void {
  console.warn(
    `[media-cache] resolveAssetBaseUrl: could not apply origin override for ${contextLabel}:`,
    err,
  );
}
