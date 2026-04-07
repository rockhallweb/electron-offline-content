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
  MediaCachePhase,
  MediaCacheReadyState,
  MediaCacheStatus,
  MediaItemsQueryOptions,
  PaginationResult,
  MediaQuerySyncOptions,
  ResolvedMediaContentItem,
} from "../shared/types.js";

declare global {
  interface Window {
    mediaCache?: MediaCacheBridge;
  }
}

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

function derivePhase(status: AsyncState<MediaCacheStatus>): MediaCachePhase {
  return status.data?.phase ?? (status.loading ? "loading" : "idle");
}

interface MediaCacheContextValue {
  bridge: MediaCacheBridge | null;
  status: AsyncState<MediaCacheStatus>;
  queryErrors: Error[];
  reportQueryError: (id: string, error: Error | null) => void;
}

export interface UseMediaItemOptions extends MediaQuerySyncOptions {
  /** Item lookup mode. */
  kind: "item";
  /** Namespace key containing the item. */
  namespace: string;
  /** Item id within the namespace. */
  id: string;
}

export interface UseMediaListOptions extends MediaItemsQueryOptions {
  /** List lookup mode. */
  kind: "list";
  /** Namespace key (or prefix when `recursive` is true). */
  namespace: string;
}

export type UseMediaOptions = UseMediaItemOptions | UseMediaListOptions;

export interface UseMediaResult<T> extends AsyncState<T> {
  /** Shared sync status for the active cache provider. */
  status: AsyncState<MediaCacheStatus>;
  /** Composite lifecycle: cache phase or `loading` before first status snapshot. */
  phase: MediaCachePhase;
  /** Global aggregated errors derived from the active provider runtime. */
  errors: MediaCacheErrors;
}

export interface UseMediaBridgeResult extends MediaCacheBridge {
  /** Shared sync status for the active cache provider. */
  status: AsyncState<MediaCacheStatus>;
  /** Composite lifecycle: cache phase or `loading` before first status snapshot. */
  phase: MediaCachePhase;
  /** Global aggregated errors derived from the active provider runtime. */
  errors: MediaCacheErrors;
}

/** Result of {@link useMediaCacheStatus}: async status plus top-level composite `phase`. */
export interface UseMediaCacheStatusResult extends AsyncState<MediaCacheStatus> {
  /** Composite lifecycle: cache phase or `loading` before first status snapshot. */
  phase: MediaCachePhase;
}

export interface UseMediaItemResult extends UseMediaResult<ResolvedMediaContentItem | null> {
  kind: "item";
}

export interface UseMediaListResult extends UseMediaResult<
  PaginationResult<ResolvedMediaContentItem>
> {
  kind: "list";
}

const MediaCacheContext = createContext<MediaCacheContextValue | null>(null);
const EMPTY_QUERY_ERRORS: Error[] = [];
let nextQueryErrorId = 0;
const MISSING_BRIDGE_ERROR =
  "MediaCache bridge is unavailable. Wrap your app in <MediaCacheProvider> or expose the preload bridge on window.mediaCache.";

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

/**
 * Returns the active {@link MediaCacheBridge} plus shared status and aggregated errors.
 *
 * This is the primary low-level hook for imperative bridge access. It exposes the underlying
 * bridge methods while bundling the same `status` and `errors` state used by the higher-level
 * React hooks.
 *
 * @returns The bridge from context with `status` and `errors`.
 * @throws When no bridge is available through context.
 */
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

/**
 * Reactive cache status for the renderer.
 *
 * Returns phase, active generation, sync progress, and last sync error. The hook auto-updates
 * when cache status changes and also exposes `refresh()` for manual reloads.
 *
 * @returns Status async state plus top-level `phase` (see {@link UseMediaCacheStatusResult}).
 * @example
 * ```tsx
 * const status = useMediaCacheStatus();
 * if (status.phase === "loading") return <p>Loading cache status...</p>;
 * return <p>Phase: {status.phase}</p>;
 * ```
 */
export function useMediaCacheStatus(): UseMediaCacheStatusResult {
  const status = useMediaCacheRuntime().status;
  return useMemo(() => ({ ...status, phase: derivePhase(status) }), [status]);
}

/**
 * Unified media query hook for single-item and namespace-list lookups.
 *
 * Item lookups return `ResolvedMediaContentItem | null`; list lookups return a paginated result.
 * The result always includes shared cache `status` plus global aggregated `errors`.
 *
 * @param options - Query definition for either one item or a namespace list/tree.
 * @returns A typed query result plus shared status and aggregated errors.
 * @example
 * ```tsx
 * const media = useMedia({ kind: "item", namespace: "space", id: "hubble-cosmos" });
 * const poster = media.data?.assetsByRole.poster;
 * ```
 */
export function useMedia(options: UseMediaItemOptions): UseMediaItemResult;
export function useMedia(options: UseMediaListOptions): UseMediaListResult;
export function useMedia(options: UseMediaOptions): UseMediaItemResult | UseMediaListResult {
  const { bridge, status, queryErrors } = useMediaCacheRuntime();
  const query = useAsyncResource<
    ResolvedMediaContentItem | null | PaginationResult<ResolvedMediaContentItem>
  >(
    () =>
      options.kind === "item"
        ? bridge.getItem(options.namespace, options.id)
        : options.recursive
          ? bridge.listNamespaceTree(options.namespace, {
              cursor: options.cursor,
              limit: options.limit,
            })
          : bridge.listNamespace(options.namespace, {
              cursor: options.cursor,
              limit: options.limit,
            }),
    buildUseMediaRefreshDeps(bridge, options),
    status,
    {
      refetchOnSyncComplete: options.refetchOnSyncComplete,
    },
  );
  const errors = useMemo(() => buildMediaCacheErrors(status, queryErrors), [status, queryErrors]);

  const phase = derivePhase(status);

  if (options.kind === "item") {
    return {
      kind: "item",
      data: query.data as ResolvedMediaContentItem | null,
      loading: query.loading,
      error: query.error,
      refresh: query.refresh,
      status,
      phase,
      errors,
    };
  }

  return {
    kind: "list",
    data: query.data as PaginationResult<ResolvedMediaContentItem> | null,
    loading: query.loading,
    error: query.error,
    refresh: query.refresh,
    status,
    phase,
    errors,
  };
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
  const { bridge, status } = useMediaCacheRuntime();
  const namespace = options?.namespace;
  const cursor = options?.cursor;
  const limit = options?.limit;
  return useAsyncResource(
    () => bridge.findByFileStem(stem, { namespace, cursor, limit }),
    [bridge, stem, namespace, cursor, limit],
    status,
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
 * Aggregates sync and active query errors into one UI-friendly error object.
 *
 * The hook is driven by the active {@link MediaCacheProvider} runtime: it uses the shared status
 * subscription plus any current query errors reported by mounted media query hooks beneath the same
 * provider. This means callers do not pass status or query states explicitly.
 *
 * @returns `MediaCacheErrors` with `syncError`, `statusError`, `queryErrors`, and `primaryError`.
 * @example
 * ```tsx
 * const media = useMedia({ kind: "item", namespace: "space", id: "hubble-cosmos" });
 * const errors = useMediaCacheErrors();
 *
 * if (errors.hasError) {
 *   console.error(errors.primaryError);
 * }
 * ```
 */
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

function buildUseMediaRefreshDeps(
  bridge: MediaCacheBridge,
  options: UseMediaOptions,
): ReadonlyArray<unknown> {
  if (options.kind === "item") {
    return [bridge, "item", options.namespace, options.id];
  }

  return [
    bridge,
    "list",
    options.namespace,
    options.recursive ?? false,
    options.cursor,
    options.limit,
  ];
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
  FileStemMatch,
  FileStemMatchQueryOptions,
  MediaCacheBridge,
  MediaCacheErrors,
  MediaCachePhase,
  MediaCacheReadyState,
  MediaCacheStatus,
  MediaItemsQueryOptions,
  MediaListQueryOptions,
  MediaQuerySyncOptions,
  ResolvedMediaContentItem,
} from "../shared/types.js";
