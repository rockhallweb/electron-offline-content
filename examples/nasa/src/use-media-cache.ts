import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
let nextQueryErrorId = 0;
let queryErrorsSnapshot: Error[] = [];
const queryErrorsById = new Map<string, Error>();
const queryErrorListeners = new Set<() => void>();

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

function subscribeQueryErrors(listener: () => void): () => void {
  queryErrorListeners.add(listener);
  return () => {
    queryErrorListeners.delete(listener);
  };
}

function getQueryErrorsSnapshot(): Error[] {
  return queryErrorsSnapshot;
}

function setQueryError(id: string, error: Error | null): void {
  if (error === null) {
    if (!queryErrorsById.delete(id)) {
      return;
    }
  } else if (queryErrorsById.get(id) === error) {
    return;
  } else {
    queryErrorsById.set(id, error);
  }

  queryErrorsSnapshot = Array.from(queryErrorsById.values());
  for (const listener of queryErrorListeners) {
    listener();
  }
}

function useQueryErrors(): Error[] {
  return useSyncExternalStore(subscribeQueryErrors, getQueryErrorsSnapshot, getQueryErrorsSnapshot);
}

function useReportedQueryError(error: Error | null): void {
  const [id] = useState(() => `query-${nextQueryErrorId++}`);

  useEffect(() => {
    setQueryError(id, error);
    return () => setQueryError(id, null);
  }, [error, id]);
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
  const queryErrors = useQueryErrors();
  const errors = useMemo(
    () => aggregateMediaCacheErrors(status, queryErrors),
    [status, queryErrors],
  );

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

  useReportedQueryError(asset.error);

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

  useReportedQueryError(assets.error);

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

  useReportedQueryError(matches.error);

  return matches;
}
