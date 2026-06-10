/**
 * Emergency fallback when no structured warning sink is available — writes to console.warn.
 * Only used when the resolved catalog projection runs without onWarn, or MediaCache
 * has neither `logging.onLog` nor the built-in development console sink.
 */
export function consoleWarnResolveAssetBaseUrlFallback(contextLabel: string, err: unknown): void {
  console.warn(
    `[media-cache] resolveAssetBaseUrl: could not apply origin override for ${contextLabel}:`,
    err,
  );
}
