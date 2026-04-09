import type {
  AssetKeyInput,
  FileStemMatch,
  MediaCacheBridge,
  MediaCachePhase,
  MediaCacheStatus,
  MediaQuerySyncOptions,
  PaginationInput,
  PaginationResult,
  ResolvedMediaAsset,
} from "../shared/types.js";

/** Async snapshot aligned with React hooks (`useMedia`, `useMediaCacheStatus`, etc.). */
export interface MediaAsyncState<T> {
  /** Latest resolved value, or `null` while loading/when unavailable. */
  data: T | null;
  /** `true` while an initial load or `refresh()` request is in flight. */
  loading: boolean;
  /** Last request error, or `null` when the latest request succeeded. */
  error: Error | null;
  /** Re-runs the underlying query and updates `data`/`error`. */
  refresh: () => Promise<void>;
}

export const MISSING_BRIDGE_ERROR =
  "MediaCache bridge is unavailable. Wrap your app in <MediaCacheProvider> or expose the preload bridge on window.mediaCache.";

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function deriveMediaCachePhase(status: MediaAsyncState<MediaCacheStatus>): MediaCachePhase {
  return status.data?.phase ?? (status.loading ? "loading" : "idle");
}

export function resolveMediaCacheBridge(options?: {
  bridge?: MediaCacheBridge;
  windowKey?: string;
}): MediaCacheBridge {
  const key = options?.windowKey ?? "mediaCache";
  const fromWindow =
    typeof window !== "undefined" ? (window as unknown as Record<string, unknown>)[key] : undefined;

  const bridge = options?.bridge ?? (fromWindow as MediaCacheBridge | undefined);

  if (
    !bridge ||
    typeof bridge.getStatus !== "function" ||
    typeof bridge.subscribeStatus !== "function"
  ) {
    throw new Error(MISSING_BRIDGE_ERROR);
  }

  return bridge;
}

const EMPTY_DISABLED_STATUS_SNAPSHOT: MediaAsyncState<MediaCacheStatus> = {
  data: null,
  loading: false,
  error: null,
  refresh: async () => undefined,
};

export interface MediaCacheStatusController {
  getSnapshot(): MediaAsyncState<MediaCacheStatus>;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  dispose(): void;
}

/**
 * Owns status fetch + `subscribeStatus` wiring; same behavior as the former
 * `useMediaCacheStatusState` hook.
 */
export function createMediaCacheStatusController(
  bridge: MediaCacheBridge | null,
  enabled: boolean,
): MediaCacheStatusController {
  if (!enabled || !bridge) {
    return {
      getSnapshot: () => EMPTY_DISABLED_STATUS_SNAPSHOT,
      subscribe: () => () => undefined,
      refresh: async () => undefined,
      dispose: () => undefined,
    };
  }

  const activeBridge = bridge;

  let data: MediaCacheStatus | null = null;
  let loading = true;
  let error: Error | null = null;
  let requestSequence = 0;
  const listeners = new Set<() => void>();

  let unsubscribeBridge: (() => void) | null = null;
  let disposed = false;

  function emit(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  async function refresh(): Promise<void> {
    const requestId = ++requestSequence;
    loading = true;
    emit();
    try {
      const nextStatus = await activeBridge.getStatus();
      if (requestId === requestSequence) {
        data = nextStatus;
        error = null;
      }
    } catch (caught) {
      if (requestId === requestSequence) {
        error = toError(caught);
      }
    } finally {
      if (requestId === requestSequence) {
        loading = false;
      }
      emit();
    }
  }

  let cachedSnapshot: MediaAsyncState<MediaCacheStatus> | null = null;

  function getSnapshot(): MediaAsyncState<MediaCacheStatus> {
    if (
      cachedSnapshot &&
      cachedSnapshot.data === data &&
      cachedSnapshot.loading === loading &&
      cachedSnapshot.error === error
    ) {
      return cachedSnapshot;
    }
    cachedSnapshot = { data, loading, error, refresh };
    return cachedSnapshot;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    if (unsubscribeBridge) {
      unsubscribeBridge();
      unsubscribeBridge = null;
    }
    requestSequence += 1;
    listeners.clear();
  }

  void refresh();
  unsubscribeBridge = activeBridge.subscribeStatus((status) => {
    requestSequence += 1;
    if (!disposed) {
      data = status;
      loading = false;
      error = null;
      emit();
    }
  });

  return {
    getSnapshot,
    subscribe,
    refresh,
    dispose,
  };
}

export interface MediaQueryWatcherInstance<T> {
  /** Compare deps to the previous call; refetches when the tuple changes. */
  syncDeps(deps: ReadonlyArray<unknown>): void;
  /** Run ready-generation refetch logic (also invoked on status updates). */
  onStatusTick(): void;
  getSnapshot(): MediaAsyncState<T>;
  /** Same as snapshot `refresh` — exposed for hosts that subscribe before first snapshot. */
  refresh(): Promise<void>;
  dispose(): void;
}

/**
 * Shared query lifecycle: dependency-based refresh + optional refetch when
 * `phase === "ready"` and `activeGenerationId` changes.
 */
export function createMediaQueryWatcherInstance<T>(options: {
  status: MediaCacheStatusController;
  /** Called on each load so callers can close over fresh arguments (React ref pattern). */
  getLoader: () => () => Promise<T>;
  refetchOnSyncComplete: boolean;
  listener: (state: MediaAsyncState<T>) => void;
}): MediaQueryWatcherInstance<T> {
  const { status, getLoader, refetchOnSyncComplete, listener } = options;

  let data: T | null = null;
  let loading = true;
  let error: Error | null = null;
  let requestSequence = 0;
  let previousDeps: ReadonlyArray<unknown> | null = null;
  let previousReadyGenerationId: number | null = null;
  let disposed = false;
  let cachedQuerySnapshot: MediaAsyncState<T> | null = null;

  function notify(): void {
    if (!disposed) {
      listener(getSnapshot());
    }
  }

  async function refresh(): Promise<void> {
    const requestId = ++requestSequence;
    loading = true;
    notify();
    try {
      const result = await getLoader()();
      if (requestId === requestSequence) {
        data = result;
        error = null;
      }
    } catch (caught) {
      if (requestId === requestSequence) {
        error = toError(caught);
      }
    } finally {
      if (requestId === requestSequence) {
        loading = false;
      }
      notify();
    }
  }

  function getSnapshot(): MediaAsyncState<T> {
    if (
      cachedQuerySnapshot &&
      cachedQuerySnapshot.data === data &&
      cachedQuerySnapshot.loading === loading &&
      cachedQuerySnapshot.error === error &&
      cachedQuerySnapshot.refresh === refresh
    ) {
      return cachedQuerySnapshot;
    }
    cachedQuerySnapshot = { data, loading, error, refresh };
    return cachedQuerySnapshot;
  }

  function onStatusTick(): void {
    const st = status.getSnapshot();
    const phase = st.data?.phase;
    const activeGenerationId = st.data?.activeGenerationId ?? null;

    if (!refetchOnSyncComplete || phase !== "ready" || activeGenerationId === null) {
      return;
    }

    if (previousReadyGenerationId !== activeGenerationId) {
      previousReadyGenerationId = activeGenerationId;
      void refresh();
    }
  }

  function syncDeps(refreshDeps: ReadonlyArray<unknown>): void {
    const shouldRefresh =
      previousDeps === null ||
      previousDeps.length !== refreshDeps.length ||
      refreshDeps.some((dependency, index) => !Object.is(dependency, previousDeps![index]));

    if (!shouldRefresh) {
      return;
    }

    previousDeps = refreshDeps;
    void refresh();
  }

  const unsubStatus = status.subscribe(() => {
    onStatusTick();
  });

  onStatusTick();

  return {
    syncDeps,
    onStatusTick,
    getSnapshot,
    refresh,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubStatus();
      requestSequence += 1;
    },
  };
}

export interface CreateMediaCacheRendererOptions {
  bridge?: MediaCacheBridge;
  windowKey?: string;
}

export interface MediaCacheRenderer {
  bridge: MediaCacheBridge;
  subscribeCacheStatus(listener: (state: MediaAsyncState<MediaCacheStatus>) => void): () => void;
  watchMediaAsset(
    key: AssetKeyInput,
    options: MediaQuerySyncOptions | undefined,
    listener: (state: MediaAsyncState<ResolvedMediaAsset | null>) => void,
  ): () => void;
  watchMediaByIndex(
    indexName: string,
    value: string,
    options: PaginationInput & MediaQuerySyncOptions,
    listener: (state: MediaAsyncState<PaginationResult<ResolvedMediaAsset>>) => void,
  ): () => void;
  watchFileStemMatch(
    stem: string,
    options: (PaginationInput & MediaQuerySyncOptions) | undefined,
    listener: (state: MediaAsyncState<PaginationResult<FileStemMatch>>) => void,
  ): () => void;
  dispose(): void;
}

/** Framework-agnostic renderer client: shared status subscription and query watchers. */
export function createMediaCacheRenderer(
  options?: CreateMediaCacheRendererOptions,
): MediaCacheRenderer {
  const bridge = resolveMediaCacheBridge(options);
  const status = createMediaCacheStatusController(bridge, true);

  function subscribeCacheStatus(
    listener: (state: MediaAsyncState<MediaCacheStatus>) => void,
  ): () => void {
    listener(status.getSnapshot());
    return status.subscribe(() => {
      listener(status.getSnapshot());
    });
  }

  return {
    bridge,
    subscribeCacheStatus,
    watchMediaAsset(key, queryOptions, listener) {
      const refetch = queryOptions?.refetchOnSyncComplete ?? true;
      const stableKey = typeof key === "string" ? key : key.join("\0");
      const instance = createMediaQueryWatcherInstance({
        status,
        getLoader: () => () => bridge.getAsset(key),
        refetchOnSyncComplete: refetch,
        listener,
      });
      instance.syncDeps([bridge, "asset", stableKey]);
      return () => instance.dispose();
    },
    watchMediaByIndex(indexName, value, listOptions, listener) {
      const { cursor, limit, refetchOnSyncComplete } = listOptions;
      const refetch = refetchOnSyncComplete ?? true;
      const instance = createMediaQueryWatcherInstance({
        status,
        getLoader: () => () => bridge.listByIndex(indexName, value, { cursor, limit }),
        refetchOnSyncComplete: refetch,
        listener,
      });
      instance.syncDeps([bridge, "index", indexName, value, cursor, limit]);
      return () => instance.dispose();
    },
    watchFileStemMatch(stem, stemOptions, listener) {
      const cursor = stemOptions?.cursor;
      const limit = stemOptions?.limit;
      const refetch = stemOptions?.refetchOnSyncComplete ?? true;
      const instance = createMediaQueryWatcherInstance({
        status,
        getLoader: () => () => bridge.findByFileStem(stem, { cursor, limit }),
        refetchOnSyncComplete: refetch,
        listener,
      });
      instance.syncDeps([bridge, stem, cursor, limit]);
      return () => instance.dispose();
    },
    dispose() {
      status.dispose();
    },
  };
}
