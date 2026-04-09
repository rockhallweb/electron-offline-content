import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import type {
  AssetKeyInput,
  FileStemMatch,
  MediaCacheBridge,
  MediaCacheErrors,
  MediaCachePhase,
  MediaCacheReadyState,
  MediaCacheStatus,
  PaginationInput,
  PaginationResult,
  MediaQuerySyncOptions,
  ResolvedMediaAsset,
} from "../shared/types.js";

declare global {
  interface Window {
    mediaCache?: MediaCacheBridge;
  }
}

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

function derivePhase(status: AsyncState<MediaCacheStatus>): MediaCachePhase {
  return status.data?.phase ?? (status.loading ? "loading" : "idle");
}

interface MediaCacheContextValue {
  bridge: MediaCacheBridge | null;
  status: AsyncState<MediaCacheStatus>;
  queryErrors: Error[];
  reportQueryError: (id: string, error: Error | null) => void;
}

export interface UseMediaBridgeResult extends MediaCacheBridge {
  status: AsyncState<MediaCacheStatus>;
  phase: MediaCachePhase;
  errors: MediaCacheErrors;
}

export interface UseMediaCacheStatusResult extends AsyncState<MediaCacheStatus> {
  phase: MediaCachePhase;
}

const MediaCacheContext = createContext<MediaCacheContextValue | null>(null);
const EMPTY_QUERY_ERRORS: Error[] = [];
let nextQueryErrorId = 0;
const MISSING_BRIDGE_ERROR =
  "MediaCache bridge is unavailable. Wrap your app in <MediaCacheProvider> or expose the preload bridge on window.mediaCache.";

export function MediaCacheProvider({
  bridge,
  children,
}: PropsWithChildren<{ bridge?: MediaCacheBridge }>) {
  const valueBridge = useMemo(() => bridge ?? window.mediaCache ?? null, [bridge]);
  const status = useMediaCacheStatusState(valueBridge, valueBridge !== null);
  const [queryErrorsById, setQueryErrorsById] = useState<Map<string, Error>>(() => new Map());

  const reportQueryError = useCallback((id: string, error: Error | null) => {
    setQueryErrorsById((previous) => {
      if (error === null) {
        if (!previous.has(id)) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(id);
        return next;
      }

      if (previous.get(id) === error) {
        return previous;
      }

      const next = new Map(previous);
      next.set(id, error);
      return next;
    });
  }, []);

  const queryErrors = useMemo(() => Array.from(queryErrorsById.values()), [queryErrorsById]);
  const value = useMemo(
    () => ({
      bridge: valueBridge,
      status,
      queryErrors,
      reportQueryError,
    }),
    [valueBridge, status, queryErrors, reportQueryError],
  );

  return <MediaCacheContext.Provider value={value}>{children}</MediaCacheContext.Provider>;
}

export function useMediaBridge(): UseMediaBridgeResult {
  const { bridge, status, queryErrors } = useMediaCacheRuntime();
  const errors = useMemo(() => buildMediaCacheErrors(status, queryErrors), [status, queryErrors]);

  return useMemo(
    () => ({
      ...bridge,
      status,
      phase: derivePhase(status),
      errors,
    }),
    [bridge, status, errors],
  );
}

export function useMediaCacheStatus(): UseMediaCacheStatusResult {
  const status = useMediaCacheRuntime().status;
  return useMemo(() => ({ ...status, phase: derivePhase(status) }), [status]);
}

/**
 * Fetches a single asset by key.
 *
 * @param key - The asset key to look up. A string or array of string segments.
 * @param options - Optional sync-triggered refetch behavior.
 */
export function useMediaAsset(
  key: AssetKeyInput,
  options?: MediaQuerySyncOptions,
): AsyncState<ResolvedMediaAsset | null> {
  const { bridge, status } = useMediaCacheRuntime();
  const stableKey = typeof key === "string" ? key : key.join("\0");
  return useAsyncResource(() => bridge.getAsset(key), [bridge, stableKey], status, {
    refetchOnSyncComplete: options?.refetchOnSyncComplete,
  });
}

/**
 * Lists assets matching a secondary index value.
 *
 * @param indexName - The index to query (e.g. `"mimeType"`, a user-defined index name).
 * @param value - The index value to match.
 * @param options - Optional pagination and sync-triggered refetch behavior.
 */
export function useMediaByIndex(
  indexName: string,
  value: string,
  options?: PaginationInput & MediaQuerySyncOptions,
): AsyncState<PaginationResult<ResolvedMediaAsset>> {
  const { bridge, status } = useMediaCacheRuntime();
  const cursor = options?.cursor;
  const limit = options?.limit;
  return useAsyncResource(
    () => bridge.listByIndex(indexName, value, { cursor, limit }),
    [bridge, indexName, value, cursor, limit],
    status,
    { refetchOnSyncComplete: options?.refetchOnSyncComplete },
  );
}

/**
 * Searches assets by normalized file stem (file name without extension).
 *
 * @param stem - Normalized file stem to search for.
 * @param options - Optional pagination and sync-triggered refetch behavior.
 */
export function useFileStemMatch(
  stem: string,
  options?: PaginationInput & MediaQuerySyncOptions,
): AsyncState<PaginationResult<FileStemMatch>> {
  const { bridge, status } = useMediaCacheRuntime();
  const cursor = options?.cursor;
  const limit = options?.limit;
  return useAsyncResource(
    () => bridge.findByFileStem(stem, { cursor, limit }),
    [bridge, stem, cursor, limit],
    status,
    { refetchOnSyncComplete: options?.refetchOnSyncComplete },
  );
}

export function useMediaCacheReady(): AsyncState<MediaCacheReadyState> {
  const status = useMediaCacheStatus();

  return {
    data: status.data
      ? {
          ready: status.data.phase === "ready",
          syncing: status.data.phase === "syncing",
          phase: status.data.phase,
          activeGenerationId: status.data.activeGenerationId,
          syncError: status.data.error,
        }
      : null,
    loading: status.loading,
    error: status.error,
    refresh: status.refresh,
  };
}

export function useMediaCacheErrors(): MediaCacheErrors {
  const { status, queryErrors } = useMediaCacheRuntime();
  return buildMediaCacheErrors(status, queryErrors);
}

function useAsyncResource<T>(
  loader: () => Promise<T>,
  refreshDeps: ReadonlyArray<unknown>,
  status: AsyncState<MediaCacheStatus>,
  options?: MediaQuerySyncOptions,
): AsyncState<T> {
  const latestLoader = useRef(loader);
  latestLoader.current = loader;
  const previousRefreshDeps = useRef<ReadonlyArray<unknown> | null>(null);

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    try {
      const result = await latestLoader.current();
      if (requestId === requestSequence.current) {
        setData(result);
        setError(null);
      }
    } catch (caught) {
      if (requestId === requestSequence.current) {
        setError(toError(caught));
      }
    } finally {
      if (requestId === requestSequence.current) {
        setLoading(false);
      }
    }
  }, []);

  useRefetchOnReadyGeneration(status, options?.refetchOnSyncComplete ?? true, () => void refresh());
  useQueryErrorRegistration(error);

  useEffect(() => {
    const previousDeps = previousRefreshDeps.current;
    const shouldRefresh =
      previousDeps === null ||
      previousDeps.length !== refreshDeps.length ||
      refreshDeps.some((dependency, index) => !Object.is(dependency, previousDeps[index]));

    if (!shouldRefresh) {
      return;
    }

    previousRefreshDeps.current = refreshDeps;
    void refresh();
  });

  return { data, loading, error, refresh };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function useMediaCacheRuntime(): {
  bridge: MediaCacheBridge;
  status: AsyncState<MediaCacheStatus>;
  queryErrors: Error[];
} {
  const runtime = useContext(MediaCacheContext);
  const bridge = runtime?.bridge;
  const standaloneStatus = useMediaCacheStatusState(bridge, runtime === null && bridge !== null);

  if (!bridge) {
    throw new Error(MISSING_BRIDGE_ERROR);
  }

  return {
    bridge,
    status: runtime?.status ?? standaloneStatus,
    queryErrors: runtime?.queryErrors ?? EMPTY_QUERY_ERRORS,
  };
}

function buildMediaCacheErrors(
  status: AsyncState<MediaCacheStatus>,
  queryErrors: Error[],
): MediaCacheErrors {
  const syncError = status.data?.error ?? null;
  const statusError = status.error;
  const primaryError = statusError ?? queryErrors[0] ?? toPrimaryError(syncError);

  return {
    syncError,
    statusError,
    queryErrors,
    hasError: primaryError !== null,
    primaryError,
  };
}

function useQueryErrorRegistration(error: Error | null): void {
  const runtime = useContext(MediaCacheContext);
  const queryErrorId = useRef<string | null>(null);

  if (queryErrorId.current === null) {
    queryErrorId.current = `query-error-${nextQueryErrorId++}`;
  }

  useEffect(() => {
    if (!runtime) {
      return;
    }

    runtime.reportQueryError(queryErrorId.current!, error);

    return () => {
      runtime.reportQueryError(queryErrorId.current!, null);
    };
  }, [runtime, error]);
}

function useMediaCacheStatusState(
  bridge: MediaCacheBridge | null | undefined,
  enabled: boolean,
): AsyncState<MediaCacheStatus> {
  const [data, setData] = useState<MediaCacheStatus | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !bridge) {
      return;
    }

    const requestId = ++requestSequence.current;
    setLoading(true);
    try {
      const nextStatus = await bridge.getStatus();
      if (requestId === requestSequence.current) {
        setData(nextStatus);
        setError(null);
      }
    } catch (caught) {
      if (requestId === requestSequence.current) {
        setError(toError(caught));
      }
    } finally {
      if (requestId === requestSequence.current) {
        setLoading(false);
      }
    }
  }, [bridge, enabled]);

  useEffect(() => {
    if (!enabled || !bridge) {
      return;
    }

    let cancelled = false;

    void refresh();
    const unsubscribe = bridge.subscribeStatus((status) => {
      requestSequence.current += 1;
      if (!cancelled) {
        setData(status);
        setLoading(false);
        setError(null);
      }
    });

    return () => {
      cancelled = true;
      requestSequence.current += 1;
      unsubscribe();
    };
  }, [bridge, enabled, refresh]);

  return useMemo(() => ({ data, loading, error, refresh }), [data, loading, error, refresh]);
}

function toPrimaryError(syncError: MediaCacheStatus["error"]): Error | null {
  if (!syncError) {
    return null;
  }

  const error = new Error(syncError.message);
  error.name = syncError.name;
  return error;
}

function useRefetchOnReadyGeneration(
  status: AsyncState<MediaCacheStatus>,
  enabled: boolean,
  onReadyGeneration: () => void,
): void {
  const callbackRef = useRef(onReadyGeneration);
  callbackRef.current = onReadyGeneration;
  const previousReadyGenerationId = useRef<number | null>(null);

  useEffect(() => {
    const phase = status.data?.phase;
    const activeGenerationId = status.data?.activeGenerationId ?? null;

    if (!enabled || phase !== "ready" || activeGenerationId === null) {
      return;
    }

    if (previousReadyGenerationId.current !== activeGenerationId) {
      previousReadyGenerationId.current = activeGenerationId;
      callbackRef.current();
    }
  }, [enabled, status.data?.activeGenerationId, status.data?.phase]);
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
  ResolvedMediaAsset,
} from "../shared/types.js";
