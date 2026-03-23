export function warnResolveAssetBaseUrlFallback(contextLabel: string, err: unknown): void {
  console.warn(
    `[media-cache] resolveAssetBaseUrl: could not apply origin override for ${contextLabel}:`,
    err,
  );
}
