import type {
  MediaCacheBridge,
  MediaCacheStatus,
  ResolvedMediaAsset,
} from "../../../src/shared/types.js";

export function createBridge(overrides: Partial<MediaCacheBridge> = {}): MediaCacheBridge {
  return {
    getStatus: async () => buildStatus("idle"),
    syncNow: async () => undefined,
    getAsset: async () => null,
    listByIndex: async () => ({ items: [], nextCursor: null }),
    findByFileStem: async () => ({ items: [], nextCursor: null }),
    subscribeStatus: () => () => undefined,
    ...overrides,
  };
}

export function buildAsset(key: string): ResolvedMediaAsset {
  return {
    key,
    version: "v1",
    mimeType: "video/mp4",
    kind: "video",
    byteLength: undefined,
    metadata: {},
    indexes: { mimeType: "video/mp4", mediaKind: "video" },
    url: `media://asset/${encodeURIComponent(key)}`,
  };
}

export function buildAssetWithVersion(key: string, version: string): ResolvedMediaAsset {
  return {
    ...buildAsset(key),
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
