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
  MediaCacheBridge,
  MediaCacheStatus,
  PaginationInput,
  PaginationResult,
  ResolvedMediaContentItem,
} from "../shared/types.js";

declare global {
  interface Window {
    mediaCache?: MediaCacheBridge;
  }
}

const MediaCacheContext = createContext<MediaCacheBridge | null>(null);

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Supplies a {@link MediaCacheBridge} to descendants via context. Uses the `bridge` prop when set,
 * otherwise falls back to `window.mediaCache` (from preload).
 */

export function MediaCacheProvider({
  bridge,
  children,
}: PropsWithChildren<{ bridge?: MediaCacheBridge }>) {
  const value = useMemo(() => bridge ?? window.mediaCache ?? null, [bridge]);
  return <MediaCacheContext.Provider value={value}>{children}</MediaCacheContext.Provider>;
}

/**
 * Returns the bridge from context or `window.mediaCache`. Throws if neither is available—wrap the
 * tree in {@link MediaCacheProvider} or expose the preload bridge first.
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
 * Loads cache status once, subscribes to live updates via `subscribeStatus`, and exposes `refresh`
 * to poll `getStatus` again.
 */

export function useMediaCacheStatus(): AsyncState<MediaCacheStatus> {
  const bridge = useMediaCacheBridge();
  const [data, setData] = useState<MediaCacheStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const requestSequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const requestId = ++requestSequence.current;
      setLoading(true);
      try {
        const status = await bridge.getStatus();
        if (!cancelled && mounted.current && requestId === requestSequence.current) {
          setData(status);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled && mounted.current && requestId === requestSequence.current) {
          setError(toError(caught));
        }
      } finally {
        if (!cancelled && mounted.current && requestId === requestSequence.current) {
          setLoading(false);
        }
      }
    };

    void load();
    const unsubscribe = bridge.subscribeStatus((status) => {
      requestSequence.current += 1;
      if (!cancelled && mounted.current) {
        setData(status);
        setLoading(false);
        setError(null);
      }
    });

    return () => {
      cancelled = true;
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
        if (mounted.current && requestId === requestSequence.current) {
          setData(status);
          setError(null);
        }
      } catch (caught) {
        if (mounted.current && requestId === requestSequence.current) {
          setError(toError(caught));
        }
      } finally {
        if (mounted.current && requestId === requestSequence.current) {
          setLoading(false);
        }
      }
    },
  };
}

/**
 * Fetches one item by `namespace` and `id`; reloads when either key or the bridge changes.
 */

export function useMediaItem(
  namespace: string,
  id: string,
): AsyncState<ResolvedMediaContentItem | null> {
  const bridge = useMediaCacheBridge();
  const loader = useCallback(() => bridge.getItem(namespace, id), [bridge, namespace, id]);
  return useAsyncResource(loader);
}

/**
 * Paginated flat list of items in a single namespace; depends on `namespace` and `pagination` cursor/limit.
 */

export function useMediaNamespace(
  namespace: string,
  pagination?: PaginationInput,
): AsyncState<PaginationResult<ResolvedMediaContentItem>> {
  const bridge = useMediaCacheBridge();
  const cursor = pagination?.cursor;
  const limit = pagination?.limit;
  const loader = useCallback(
    () => bridge.listNamespace(namespace, { cursor, limit }),
    [bridge, namespace, cursor, limit],
  );
  return useAsyncResource(loader);
}

/**
 * Paginated items under a namespace key prefix (`listNamespaceTree`); depends on `prefix` and pagination.
 */

export function useMediaNamespaceTree(
  prefix: string,
  pagination?: PaginationInput,
): AsyncState<PaginationResult<ResolvedMediaContentItem>> {
  const bridge = useMediaCacheBridge();
  const cursor = pagination?.cursor;
  const limit = pagination?.limit;
  const loader = useCallback(
    () => bridge.listNamespaceTree(prefix, { cursor, limit }),
    [bridge, prefix, cursor, limit],
  );
  return useAsyncResource(loader);
}

/**
 * Paginated stem search across assets (`findByFileStem`); depends on `stem`, optional `namespace`, and pagination.
 */

export function useFileStemMatch(
  stem: string,
  options?: PaginationInput & { namespace?: string },
): AsyncState<PaginationResult<FileStemMatch>> {
  const bridge = useMediaCacheBridge();
  const namespace = options?.namespace;
  const cursor = options?.cursor;
  const limit = options?.limit;
  const loader = useCallback(
    () => bridge.findByFileStem(stem, { namespace, cursor, limit }),
    [bridge, stem, namespace, cursor, limit],
  );
  return useAsyncResource(loader);
}

function useAsyncResource<T>(loader: () => Promise<T>): AsyncState<T> {
  const latestLoader = useRef(loader);
  latestLoader.current = loader;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const requestSequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, []);

  const refresh = async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    try {
      const result = await latestLoader.current();
      if (mounted.current && requestId === requestSequence.current) {
        setData(result);
        setError(null);
      }
    } catch (caught) {
      if (mounted.current && requestId === requestSequence.current) {
        setError(toError(caught));
      }
    } finally {
      if (mounted.current && requestId === requestSequence.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void refresh();
  }, [loader]);

  return { data, loading, error, refresh };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type {
  FileStemMatch,
  MediaCacheBridge,
  MediaCacheStatus,
  ResolvedMediaContentItem,
} from "../shared/types.js";
