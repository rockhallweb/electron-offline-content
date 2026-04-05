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
  FileStemMatch,
  FileStemMatchQueryOptions,
  MediaCacheBridge,
  MediaCacheErrors,
  MediaCacheReadyState,
  MediaCacheStatus,
  MediaItemsQueryOptions,
  PaginationInput,
  PaginationResult,
  MediaQuerySyncOptions,
  ResolvedMediaContentItem,
} from "../shared/types.js";

declare global {
  interface Window {
    mediaCache?: MediaCacheBridge;
  }
}

const MediaCacheContext = createContext<MediaCacheBridge | null>(null);

interface AsyncState<T> {
  /** Latest resolved value, or `null` while loading/when unavailable. */
  data: T | null;
  /** `true` while an initial load or `refresh()` request is in flight. */
  loading: boolean;
  /** Last request error, or `null` when the latest request succeeded. */
  error: Error | null;
  /** Re-runs the underlying query and updates `data`/`error`. */
  refresh: () => Promise<void>;
}

type MediaCacheStatusState = Pick<AsyncState<MediaCacheStatus>, "data" | "error">;

/**
 * Provides a {@link MediaCacheBridge} to all descendant hooks.
 *
 * If your preload uses the default `window.mediaCache` key, you can omit `bridge`.
 * If preload exposes a custom key, pass that bridge explicitly.
 *
 * @param props.bridge - Optional explicit bridge instance to use.
 * @param props.children - React subtree that can call media cache hooks.
 * @example
 * ```tsx
 * <MediaCacheProvider>
 *   <App />
 * </MediaCacheProvider>
 * ```
 */
export function MediaCacheProvider({
  bridge,
  children,
}: PropsWithChildren<{ bridge?: MediaCacheBridge }>) {
  const value = useMemo(() => bridge ?? window.mediaCache ?? null, [bridge]);
  return <MediaCacheContext.Provider value={value}>{children}</MediaCacheContext.Provider>;
}

/**
 * Returns the active {@link MediaCacheBridge}.
 *
 * This is a low-level hook used by the higher-level query hooks. Most app code should
 * prefer `useMediaCacheStatus`, `useMediaItems`, `useMediaItem`, and `useFileStemMatch`.
 *
 * @returns The bridge from context, or `window.mediaCache` as a fallback.
 * @throws When no bridge is available through context or `window.mediaCache`.
 */
export function useMediaCacheBridge(): MediaCacheBridge {
  const bridge = useContext(MediaCacheContext) ?? window.mediaCache ?? null;
  if (!bridge) {
    throw new Error(
      "MediaCache bridge is unavailable. Wrap your app in <MediaCacheProvider> or expose the preload bridge on window.mediaCache.",
    );
  }
  return bridge;
}

/**
 * Reactive cache status for the renderer.
 *
 * Returns phase, active generation, sync progress, and last sync error. The hook auto-updates
 * when cache status changes and also exposes `refresh()` for manual reloads.
 *
 * @returns `AsyncState<MediaCacheStatus>` with live status updates.
 * @example
 * ```tsx
 * const status = useMediaCacheStatus();
 * if (status.loading) return <p>Loading cache status...</p>;
 * return <p>Phase: {status.data?.phase ?? "idle"}</p>;
 * ```
 */
export function useMediaCacheStatus(): AsyncState<MediaCacheStatus> {
  const bridge = useMediaCacheBridge();
  const [data, setData] = useState<MediaCacheStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const requestId = ++requestSequence.current;
      setLoading(true);
      try {
        const status = await bridge.getStatus();
        if (!cancelled && requestId === requestSequence.current) {
          setData(status);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled && requestId === requestSequence.current) {
          setError(toError(caught));
        }
      } finally {
        if (!cancelled && requestId === requestSequence.current) {
          setLoading(false);
        }
      }
    };

    void load();
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
  }, [bridge]);

  return {
    data,
    loading,
    error,
    refresh: async () => {
      const requestId = ++requestSequence.current;
      setLoading(true);
      try {
        const status = await bridge.getStatus();
        if (requestId === requestSequence.current) {
          setData(status);
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
    },
  };
}

/**
 * Fetches a single item by namespace + item id.
 *
 * @param namespace - Namespace key containing the item.
 * @param id - Item id within the namespace.
 * @param options - Optional sync-triggered refetch behavior.
 * @returns `AsyncState<ResolvedMediaContentItem | null>`. `data` is `null` while loading or when no item exists.
 * @example
 * ```tsx
 * const item = useMediaItem("space", "hubble-cosmos");
 * const poster = item.data?.assetsByRole.poster;
 * ```
 */
export function useMediaItem(
  namespace: string,
  id: string,
  options?: MediaQuerySyncOptions,
): AsyncState<ResolvedMediaContentItem | null> {
  const bridge = useMediaCacheBridge();
  return useAsyncResource(
    () => bridge.getItem(namespace, id),
    [bridge, namespace, id],
    bridge,
    options,
  );
}

/**
 * Fetches paginated items for a namespace or namespace tree.
 *
 * `recursive: false` (default) returns only items in the exact namespace.
 * `recursive: true` includes dot-delimited descendants (for example `courses` + `courses.advanced`).
 *
 * @param namespaceOrPrefix - Namespace key (or namespace prefix when `recursive` is true).
 * @param options - Pagination + recursive behavior + sync-triggered refetch.
 * @returns `AsyncState<PaginationResult<ResolvedMediaContentItem>>`.
 * @example
 * ```tsx
 * const root = useMediaItems("space", { limit: 20 });
 * const tree = useMediaItems("space", { recursive: true, limit: 40 });
 * ```
 */
export function useMediaItems(
  namespaceOrPrefix: string,
  options?: MediaItemsQueryOptions,
): AsyncState<PaginationResult<ResolvedMediaContentItem>> {
  const bridge = useMediaCacheBridge();
  const cursor = options?.cursor;
  const limit = options?.limit;
  const recursive = options?.recursive ?? false;
  return useAsyncResource(
    () =>
      recursive
        ? bridge.listNamespaceTree(namespaceOrPrefix, { cursor, limit })
        : bridge.listNamespace(namespaceOrPrefix, { cursor, limit }),
    [bridge, recursive, namespaceOrPrefix, cursor, limit],
    bridge,
    {
      refetchOnSyncComplete: options?.refetchOnSyncComplete,
    },
  );
}

/**
 * Paginated flat list of items in a single namespace.
 * @deprecated Prefer `useMediaItems(namespace, { ...pagination })` for a single list API.
 */
export function useMediaNamespace(
  namespace: string,
  pagination?: PaginationInput,
): AsyncState<PaginationResult<ResolvedMediaContentItem>> {
  return useMediaItems(namespace, {
    ...pagination,
    recursive: false,
  });
}

/**
 * Paginated items under a namespace key prefix (`listNamespaceTree`).
 * @deprecated Prefer `useMediaItems(prefix, { recursive: true, ...pagination })` for tree queries.
 */
export function useMediaNamespaceTree(
  prefix: string,
  pagination?: PaginationInput,
): AsyncState<PaginationResult<ResolvedMediaContentItem>> {
  return useMediaItems(prefix, {
    ...pagination,
    recursive: true,
  });
}

/**
 * Searches assets by normalized file stem (file name without extension).
 *
 * Useful when you know the source filename pattern and want matching items quickly.
 *
 * @param stem - Normalized file stem to search for (for example `mars-large-organics`).
 * @param options - Optional namespace filter, pagination, and sync-triggered refetch behavior.
 * @returns `AsyncState<PaginationResult<FileStemMatch>>`.
 * @example
 * ```tsx
 * const matches = useFileStemMatch("mars-large-organics", { limit: 10 });
 * ```
 */
export function useFileStemMatch(
  stem: string,
  options?: FileStemMatchQueryOptions,
): AsyncState<PaginationResult<FileStemMatch>> {
  const bridge = useMediaCacheBridge();
  const namespace = options?.namespace;
  const cursor = options?.cursor;
  const limit = options?.limit;
  return useAsyncResource(
    () => bridge.findByFileStem(stem, { namespace, cursor, limit }),
    [bridge, stem, namespace, cursor, limit],
    bridge,
    {
      refetchOnSyncComplete: options?.refetchOnSyncComplete,
    },
  );
}

/**
 * Lightweight readiness view derived from `useMediaCacheStatus()`.
 *
 * Use this for simple loading gates and "is ready yet?" UI. For detailed progress/diagnostics,
 * use `useMediaCacheStatus()` directly.
 *
 * @returns `AsyncState<MediaCacheReadyState>` with `ready`, `syncing`, and current `phase`.
 * @example
 * ```tsx
 * const ready = useMediaCacheReady();
 * if (!ready.data?.ready) return <p>Preparing offline content...</p>;
 * ```
 * @see useMediaCacheStatus
 */
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

/**
 * Aggregates sync and query errors into one UI-friendly error object.
 *
 * Pass a shared status result from {@link useMediaCacheStatus} plus any number of query states
 * (for example item/list/search hooks). This avoids creating a second status subscription just to
 * derive error UI.
 *
 * @param status - Shared result from `useMediaCacheStatus()`.
 * @param queryStates - Hook states containing an `error` field (typically from media query hooks).
 * @returns `MediaCacheErrors` with `syncError`, `statusError`, `queryErrors`, and `primaryError`.
 * @example
 * ```tsx
 * const status = useMediaCacheStatus();
 * const item = useMediaItem("space", "hubble-cosmos");
 * const list = useMediaItems("space", { limit: 20 });
 * const errors = useMediaCacheErrors(status, item, list);
 * ```
 */
export function useMediaCacheErrors(
  status: MediaCacheStatusState,
  ...queryStates: Array<{ error: Error | null }>
): MediaCacheErrors {
  const queryErrors = queryStates.flatMap((state) => (state.error ? [state.error] : []));
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

function useAsyncResource<T>(
  loader: () => Promise<T>,
  refreshDeps: ReadonlyArray<unknown>,
  bridge: MediaCacheBridge,
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

  useRefetchOnReadyGeneration(bridge, options?.refetchOnSyncComplete ?? true, () => void refresh());

  // Intentionally no dependency array: this runs after each render so we can
  // compare refreshDeps ourselves while always invoking the latest loader.
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

function toPrimaryError(syncError: MediaCacheStatus["error"]): Error | null {
  if (!syncError) {
    return null;
  }

  const error = new Error(syncError.message);
  error.name = syncError.name;
  return error;
}

function useRefetchOnReadyGeneration(
  bridge: MediaCacheBridge,
  enabled: boolean,
  onReadyGeneration: () => void,
): void {
  const callbackRef = useRef(onReadyGeneration);
  callbackRef.current = onReadyGeneration;
  const previousReadyGenerationId = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    return bridge.subscribeStatus((status) => {
      if (status.phase !== "ready" || status.activeGenerationId === null) {
        return;
      }

      if (previousReadyGenerationId.current !== status.activeGenerationId) {
        previousReadyGenerationId.current = status.activeGenerationId;
        callbackRef.current();
      }
    });
  }, [bridge, enabled]);
}

export type {
  FileStemMatch,
  FileStemMatchQueryOptions,
  MediaCacheBridge,
  MediaCacheErrors,
  MediaCacheReadyState,
  MediaCacheStatus,
  MediaItemsQueryOptions,
  MediaQuerySyncOptions,
  ResolvedMediaContentItem,
} from "../shared/types.js";
