import { useEffect, useMemo, useState } from "react";
import {
  aggregateMediaCacheErrors,
  createMediaCacheRenderer,
  deriveMediaCachePhase,
  type AssetKeyInput,
  type FileStemMatch,
  type MediaAsyncState,
  type MediaCacheRenderer,
  type MediaCacheStatus,
  type MediaQuerySyncOptions,
  type PaginationInput,
  type PaginationResult,
  type ResolvedMediaAsset,
} from "@rockhall/electron-offline-content/renderer";

export type { ResolvedMediaAsset };

let renderer: MediaCacheRenderer | null = null;

function getRenderer(): MediaCacheRenderer {
  renderer ??= createMediaCacheRenderer();
  return renderer;
}

function initialState<T>(): MediaAsyncState<T> {
  return {
    data: null,
    loading: true,
    error: null,
    refresh: async () => undefined,
  };
}

export function useMediaCacheStatus(): MediaAsyncState<MediaCacheStatus> & {
  phase: ReturnType<typeof deriveMediaCachePhase>;
} {
  const [status, setStatus] = useState<MediaAsyncState<MediaCacheStatus>>(() => initialState());

  useEffect(() => getRenderer().subscribeCacheStatus(setStatus), []);

  return useMemo(() => ({ ...status, phase: deriveMediaCachePhase(status) }), [status]);
}

export function useMediaBridge() {
  const status = useMediaCacheStatus();
  const errors = useMemo(() => aggregateMediaCacheErrors(status, []), [status]);

  return {
    ...getRenderer().bridge,
    status,
    phase: status.phase,
    errors,
  };
}

export function useMediaAsset(
  key: AssetKeyInput,
  options?: MediaQuerySyncOptions,
): MediaAsyncState<ResolvedMediaAsset | null> {
  const isSegmentKey = typeof key !== "string";
  const stableKey = typeof key === "string" ? key : key.join("\0");
  const assetKey = useMemo<AssetKeyInput>(
    () => (isSegmentKey ? stableKey.split("\0") : stableKey),
    [isSegmentKey, stableKey],
  );
  const refetchOnSyncComplete = options?.refetchOnSyncComplete;
  const [asset, setAsset] = useState<MediaAsyncState<ResolvedMediaAsset | null>>(() =>
    initialState(),
  );

  useEffect(
    () => getRenderer().watchMediaAsset(assetKey, { refetchOnSyncComplete }, setAsset),
    [assetKey, refetchOnSyncComplete],
  );

  return asset;
}

export function useMediaByIndex(
  indexName: string,
  value: string,
  options?: PaginationInput & MediaQuerySyncOptions,
): MediaAsyncState<PaginationResult<ResolvedMediaAsset>> {
  const cursor = options?.cursor;
  const limit = options?.limit;
  const refetchOnSyncComplete = options?.refetchOnSyncComplete;
  const [assets, setAssets] = useState<MediaAsyncState<PaginationResult<ResolvedMediaAsset>>>(() =>
    initialState(),
  );

  useEffect(
    () =>
      getRenderer().watchMediaByIndex(
        indexName,
        value,
        { cursor, limit, refetchOnSyncComplete },
        setAssets,
      ),
    [indexName, value, cursor, limit, refetchOnSyncComplete],
  );

  return assets;
}

export function useFileStemMatch(
  stem: string,
  options?: PaginationInput & MediaQuerySyncOptions,
): MediaAsyncState<PaginationResult<FileStemMatch>> {
  const cursor = options?.cursor;
  const limit = options?.limit;
  const refetchOnSyncComplete = options?.refetchOnSyncComplete;
  const [matches, setMatches] = useState<MediaAsyncState<PaginationResult<FileStemMatch>>>(() =>
    initialState(),
  );

  useEffect(
    () =>
      getRenderer().watchFileStemMatch(stem, { cursor, limit, refetchOnSyncComplete }, setMatches),
    [stem, cursor, limit, refetchOnSyncComplete],
  );

  return matches;
}
