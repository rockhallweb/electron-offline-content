import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import type {
  FileStemMatch,
  MediaCacheBridge,
  MediaCacheStatus,
  PaginationInput,
  PaginationResult,
  ResolvedMediaContentItem,
} from '../shared/types.js';

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

export function MediaCacheProvider({
  bridge,
  children,
}: PropsWithChildren<{ bridge?: MediaCacheBridge }>) {
  const value = useMemo(() => bridge ?? window.mediaCache ?? null, [bridge]);
  return <MediaCacheContext.Provider value={value}>{children}</MediaCacheContext.Provider>;
}

export function useMediaCacheBridge(): MediaCacheBridge {
  const bridge = useContext(MediaCacheContext) ?? window.mediaCache ?? null;
  if (!bridge) {
    throw new Error(
      'MediaCache bridge is unavailable. Wrap your app in <MediaCacheProvider> or expose the preload bridge on window.mediaCache.',
    );
  }
  return bridge;
}

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

export function useMediaItem(
  namespace: string,
  id: string,
): AsyncState<ResolvedMediaContentItem | null> {
  const bridge = useMediaCacheBridge();
  return useAsyncResource(() => bridge.getItem(namespace, id), [bridge, namespace, id]);
}

export function useMediaNamespace(
  namespace: string,
  pagination?: PaginationInput,
): AsyncState<PaginationResult<ResolvedMediaContentItem>> {
  const bridge = useMediaCacheBridge();
  return useAsyncResource(
    () => bridge.listNamespace(namespace, pagination),
    [bridge, namespace, pagination?.cursor, pagination?.limit],
  );
}

export function useMediaNamespaceTree(
  prefix: string,
  pagination?: PaginationInput,
): AsyncState<PaginationResult<ResolvedMediaContentItem>> {
  const bridge = useMediaCacheBridge();
  return useAsyncResource(
    () => bridge.listNamespaceTree(prefix, pagination),
    [bridge, prefix, pagination?.cursor, pagination?.limit],
  );
}

export function useFileStemMatch(
  stem: string,
  options?: PaginationInput & { namespace?: string },
): AsyncState<PaginationResult<FileStemMatch>> {
  const bridge = useMediaCacheBridge();
  return useAsyncResource(
    () => bridge.findByFileStem(stem, options),
    [bridge, stem, options?.namespace, options?.cursor, options?.limit],
  );
}

function useAsyncResource<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
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
  }, deps);

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
} from '../shared/types.js';
