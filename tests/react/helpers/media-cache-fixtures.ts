import type {
  MediaCacheBridge,
  MediaCacheStatus,
  ResolvedMediaContentItem,
} from "../../../src/shared/types.js";

export function createBridge(overrides: Partial<MediaCacheBridge> = {}): MediaCacheBridge {
  return {
    getStatus: async () => buildStatus("idle"),
    syncNow: async () => undefined,
    getItem: async () => null,
    listNamespace: async () => ({ items: [], nextCursor: null }),
    listNamespaceTree: async () => ({ items: [], nextCursor: null }),
    findByFileStem: async () => ({ items: [], nextCursor: null }),
    subscribeStatus: () => () => undefined,
    ...overrides,
  };
}

export function buildItem(id: string): ResolvedMediaContentItem {
  return {
    namespace: "nature",
    id,
    version: "v1",
    kind: "video",
    blobs: {},
    metadata: {},
    assets: [],
    assetsByRole: {},
  };
}

export function buildItemWithVersion(id: string, version: string): ResolvedMediaContentItem {
  return {
    ...buildItem(id),
    version,
  };
}

export function buildStatus(
  phase: MediaCacheStatus["phase"],
  activeGenerationId = 0,
): MediaCacheStatus {
  return {
    phase,
    storageRoot: "/tmp/media-cache",
    activeGenerationId: phase === "ready" ? activeGenerationId : null,
    progress: null,
    lastRun: null,
    error: null,
    updatedAt: Date.now(),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}
