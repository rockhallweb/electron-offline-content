import "./window-globals.js";
import type { MediaAsyncState } from "./runtime.js";
import {
  type CreateMediaCacheRendererOptions,
  type MediaCacheRenderer,
  createMediaCacheRenderer as createMediaCacheRendererImpl,
} from "./runtime.js";

export { aggregateMediaCacheErrors, mediaCacheReadyFromStatus } from "./helpers.js";

export type { MediaAsyncState };
export { MISSING_BRIDGE_ERROR, deriveMediaCachePhase, resolveMediaCacheBridge } from "./runtime.js";

export type CreateMediaCacheRendererInput = CreateMediaCacheRendererOptions;

/**
 * Framework-agnostic entry: resolves the preload bridge, subscribes to cache status,
 * and exposes watchers aligned with the React hooks’ async semantics.
 */
export function createMediaCacheRenderer(
  options?: CreateMediaCacheRendererOptions,
): MediaCacheRenderer {
  return createMediaCacheRendererImpl(options);
}

export type {
  AssetKeyInput,
  FileStemMatch,
  MediaCacheBridge,
  MediaCacheErrors,
  MediaCachePhase,
  MediaCacheReadyState,
  MediaCacheStatus,
  MediaQuerySyncOptions,
  PaginationInput,
  PaginationResult,
  ResolvedMediaAsset,
} from "../shared/types.js";
