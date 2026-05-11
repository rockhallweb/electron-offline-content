import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
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
import "../renderer/window-globals.js";
import {
  type MediaAsyncState,
  type MediaCacheStatusController,
  MISSING_BRIDGE_ERROR,
  createMediaCacheStatusController,
  createMediaQueryWatcherInstance,
  deriveMediaCachePhase,
} from "../renderer/runtime.js";
import { aggregateMediaCacheErrors, mediaCacheReadyFromStatus } from "../renderer/helpers.js";

type AsyncState<T> = MediaAsyncState<T>;

interface MediaCacheContextValue {
  bridge: MediaCacheBridge | null;
  statusController: MediaCacheStatusController | null;
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
let nextQueryErrorId = 0;

export function MediaCacheProvider({
  bridge,
  children,
}: PropsWithChildren<{ bridge?: MediaCacheBridge }>) {
  const valueBridge = useMemo(() => bridge ?? window.mediaCache ?? null, [bridge]);
  const statusController = useMemo(
    () => createMediaCacheStatusController(valueBridge, valueBridge !== null),
    [valueBridge],
  );

  useEffect(() => () => statusController.dispose(), [statusController]);

  const [queryErrorsById, setQueryErrorsById] = useState<Map<string, Error>>(() => new Map());

  const reportQueryError = useCallback((id: string, error: Error | null) => {
    setQueryErrorsById((previous: Map<string, Error>) => {
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
      statusController,
      queryErrors,
      reportQueryError,
    }),
    [valueBridge, statusController, queryErrors, reportQueryError],
  );

  return <MediaCacheContext.Provider value={value}>{children}</MediaCacheContext.Provider>;
}

export function useMediaBridge(): UseMediaBridgeResult {
  const { bridge, status, queryErrors } = useMediaCacheRuntime();
  const errors = useMemo(
    () => aggregateMediaCacheErrors(status, queryErrors),
    [status, queryErrors],
  );

  return useMemo(
    () => ({
      ...bridge,
      status,
      phase: deriveMediaCachePhase(status),
      errors,
    }),
    [bridge, status, errors],
  );
}

export function useMediaCacheStatus(): UseMediaCacheStatusResult {
  const status = useMediaCacheRuntime().status;
  return useMemo(() => ({ ...status, phase: deriveMediaCachePhase(status) }), [status]);
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
  const { bridge, statusController } = useMediaCacheRuntime();
  const stableKey = typeof key === "string" ? key : key.join("\0");
  return useAsyncResource(() => bridge.getAsset(key), [bridge, stableKey], statusController, {
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
  const { bridge, statusController } = useMediaCacheRuntime();
  const cursor = options?.cursor;
  const limit = options?.limit;
  return useAsyncResource(
    () => bridge.listByIndex(indexName, value, { cursor, limit }),
    [bridge, indexName, value, cursor, limit],
    statusController,
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
  const { bridge, statusController } = useMediaCacheRuntime();
  const cursor = options?.cursor;
  const limit = options?.limit;
  return useAsyncResource(
    () => bridge.findByFileStem(stem, { cursor, limit }),
    [bridge, stem, cursor, limit],
    statusController,
    { refetchOnSyncComplete: options?.refetchOnSyncComplete },
  );
}

export function useMediaCacheReady(): AsyncState<MediaCacheReadyState> {
  const status = useMediaCacheStatus();

  return {
    data: mediaCacheReadyFromStatus(status.data ?? undefined),
    loading: status.loading,
    error: status.error,
    refresh: status.refresh,
  };
}

export function useMediaCacheErrors(): MediaCacheErrors {
  const { status, queryErrors } = useMediaCacheRuntime();
  return aggregateMediaCacheErrors(status, queryErrors);
}

function useAsyncResource<T>(
  loader: () => Promise<T>,
  refreshDeps: ReadonlyArray<unknown>,
  statusController: MediaCacheStatusController,
  options?: MediaQuerySyncOptions,
): AsyncState<T> {
  const latestLoader = useRef(loader);
  latestLoader.current = loader;

  const watcherRef = useRef<ReturnType<typeof createMediaQueryWatcherInstance<T>> | null>(null);
  const [, forceRender] = useReducer((count: number) => count + 1, 0);

  useLayoutEffect(() => {
    const instance = createMediaQueryWatcherInstance({
      status: statusController,
      getLoader: () => latestLoader.current,
      refetchOnSyncComplete: options?.refetchOnSyncComplete ?? true,
      listener: () => forceRender(),
    });
    watcherRef.current = instance;
    instance.syncDeps(refreshDeps);
    forceRender();
    return () => {
      instance.dispose();
      watcherRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps compared imperatively via syncDeps
  }, [statusController, options?.refetchOnSyncComplete]);

  useEffect(() => {
    watcherRef.current?.syncDeps(refreshDeps);
  });

  const snapshot =
    watcherRef.current?.getSnapshot() ??
    ({
      data: null,
      loading: true,
      error: null,
      refresh: async () => {
        await watcherRef.current?.refresh();
      },
    } as AsyncState<T>);

  useQueryErrorRegistration(snapshot.error);

  return snapshot;
}

function useMediaCacheRuntime(): {
  bridge: MediaCacheBridge;
  status: AsyncState<MediaCacheStatus>;
  statusController: MediaCacheStatusController;
  queryErrors: Error[];
} {
  const runtime = useContext(MediaCacheContext);
  const bridge = runtime?.bridge;
  const statusController = runtime?.statusController;

  if (!bridge || !statusController) {
    throw new Error(MISSING_BRIDGE_ERROR);
  }

  const status = useSyncExternalStore(
    statusController.subscribe,
    statusController.getSnapshot,
    statusController.getSnapshot,
  );

  return {
    bridge,
    status,
    statusController,
    queryErrors: runtime.queryErrors,
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
