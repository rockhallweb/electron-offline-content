import { describe, expect, it, vi } from "vitest";
import {
  MISSING_BRIDGE_ERROR,
  aggregateMediaCacheErrors,
  createMediaCacheRenderer,
  mediaCacheReadyFromStatus,
  resolveMediaCacheBridge,
} from "../../src/renderer/index.js";
import { BRIDGE_OPERATION_NAMES } from "../../src/shared/bridge-operations.js";
import type { MediaCacheBridge, MediaCacheStatus } from "../../src/shared/types.js";
import {
  buildAssetWithVersion,
  buildStatus,
  createBridge,
  deferred,
} from "./helpers/media-cache-fixtures.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createMediaCacheRenderer", () => {
  it("refetches asset watch on ready-generation updates by default", async () => {
    const statusRef: { current: ((status: MediaCacheStatus) => void) | null } = { current: null };
    let calls = 0;
    const bridge = createBridge({
      getAsset: async () => {
        calls += 1;
        return buildAssetWithVersion("forest", calls === 1 ? "v1" : "v2");
      },
      subscribeStatus: (listener: (status: MediaCacheStatus) => void) => {
        statusRef.current = listener;
        return () => {
          statusRef.current = null;
        };
      },
    });

    const renderer = createMediaCacheRenderer({ bridge });
    const updates: string[] = [];
    const unsub = renderer.watchMediaAsset("forest", undefined, (state) => {
      if (state.data?.version) {
        updates.push(state.data.version);
      }
    });

    try {
      await waitUntil(() => updates.includes("v1"));
      statusRef.current?.(buildStatus("ready", 1));
      await waitUntil(() => updates.includes("v2"));
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      unsub();
      renderer.dispose();
    }
  });

  it("respects refetchOnSyncComplete false for asset watch", async () => {
    const statusRef: { current: ((status: MediaCacheStatus) => void) | null } = { current: null };
    let calls = 0;
    const bridge = createBridge({
      getAsset: async () => {
        calls += 1;
        return buildAssetWithVersion("forest", calls === 1 ? "v1" : "v2");
      },
      subscribeStatus: (listener: (status: MediaCacheStatus) => void) => {
        statusRef.current = listener;
        return () => {
          statusRef.current = null;
        };
      },
    });

    const renderer = createMediaCacheRenderer({ bridge });
    const versions: string[] = [];
    const unsub = renderer.watchMediaAsset("forest", { refetchOnSyncComplete: false }, (s) => {
      if (s.data?.version) {
        versions.push(s.data.version);
      }
    });

    try {
      await waitUntil(() => versions.length === 1 && versions[0] === "v1");
      statusRef.current?.(buildStatus("ready", 1));
      await new Promise((r) => setTimeout(r, 30));
      expect(versions).toEqual(["v1"]);
      expect(calls).toBe(1);
    } finally {
      unsub();
      renderer.dispose();
    }
  });

  it("subscribeCacheStatus invokes listener with initial snapshot", async () => {
    const bridge = createBridge();
    const renderer = createMediaCacheRenderer({ bridge });
    const phases: string[] = [];
    const unsub = renderer.subscribeCacheStatus((s) => {
      phases.push(s.data?.phase ?? "null");
    });

    await waitUntil(() => phases.includes("idle"));
    expect(phases).toContain("idle");
    unsub();
    renderer.dispose();
  });

  it("status refresh pulls a new snapshot for subscribers", async () => {
    let phase: MediaCacheStatus["phase"] = "idle";
    const bridge = createBridge({
      getStatus: async () => buildStatus(phase),
    });
    const renderer = createMediaCacheRenderer({ bridge });

    let lastPhase: string | null = null;
    let refresh: (() => Promise<void>) | null = null;
    const unsub = renderer.subscribeCacheStatus((s) => {
      lastPhase = s.data?.phase ?? null;
      refresh = s.refresh;
    });

    await waitUntil(() => lastPhase === "idle");
    expect(refresh).toBeTypeOf("function");

    phase = "syncing";
    await refresh!();

    await waitUntil(() => lastPhase === "syncing");
    unsub();
    renderer.dispose();
  });

  it("allows index watches without options", async () => {
    const listByIndex = vi.fn<MediaCacheBridge["listByIndex"]>(async () => ({
      items: [],
      nextCursor: null,
    }));
    const bridge = createBridge({ listByIndex });
    const renderer = createMediaCacheRenderer({ bridge });
    const updates: number[] = [];
    const unsub = renderer.watchMediaByIndex("mediaKind", "video", undefined, (state) => {
      updates.push(state.data?.items.length ?? -1);
    });

    await waitUntil(() => updates.includes(0));
    expect(listByIndex).toHaveBeenCalledWith("mediaKind", "video", {
      cursor: undefined,
      limit: undefined,
    });

    unsub();
    renderer.dispose();
  });

  it("disposes active query watchers when renderer is disposed", async () => {
    const pendingAsset = deferred<Awaited<ReturnType<typeof buildAssetWithVersion>>>();
    const bridge = createBridge({
      getAsset: () => pendingAsset.promise,
    });
    const renderer = createMediaCacheRenderer({ bridge });
    const versions: string[] = [];

    renderer.watchMediaAsset("forest", undefined, (state) => {
      if (state.data?.version) {
        versions.push(state.data.version);
      }
    });

    renderer.dispose();
    pendingAsset.resolve(buildAssetWithVersion("forest", "v1"));
    await new Promise((r) => setTimeout(r, 30));

    expect(versions).toEqual([]);
  });
});

describe("renderer helpers", () => {
  it("mediaCacheReadyFromStatus maps phases", () => {
    const ready = mediaCacheReadyFromStatus(buildStatus("ready", 3));
    expect(ready?.ready).toBe(true);
    expect(ready?.activeGenerationId).toBe(3);
    expect(mediaCacheReadyFromStatus(null)).toBeNull();
  });

  it("aggregateMediaCacheErrors prefers status error then query errors", () => {
    const statusState = {
      data: {
        ...buildStatus("error", 0),
        error: { name: "E", code: "C", message: "sync" },
      },
      loading: false,
      error: null,
      refresh: async () => undefined,
    };

    const withStatusErr = {
      ...statusState,
      error: new Error("status load failed"),
    };
    expect(aggregateMediaCacheErrors(withStatusErr, [new Error("q1")]).primaryError?.message).toBe(
      "status load failed",
    );

    expect(
      aggregateMediaCacheErrors(statusState, [new Error("query first")]).primaryError?.message,
    ).toBe("query first");
  });
});

describe("resolveMediaCacheBridge", () => {
  it("resolves from window key", () => {
    const bridge = createBridge();
    const win = window as unknown as { mediaCache?: typeof bridge };
    const hadMediaCache = Object.prototype.hasOwnProperty.call(win, "mediaCache");
    const orig = win.mediaCache;
    win.mediaCache = bridge;
    try {
      expect(resolveMediaCacheBridge({})).toBe(bridge);
    } finally {
      if (hadMediaCache) {
        win.mediaCache = orig;
      } else {
        delete win.mediaCache;
      }
    }
  });

  it("throws when a registry operation is missing from the bridge", () => {
    for (const name of BRIDGE_OPERATION_NAMES) {
      const incomplete = createBridge() as unknown as Record<string, unknown>;
      delete incomplete[name];
      expect(() =>
        resolveMediaCacheBridge({ bridge: incomplete as unknown as MediaCacheBridge }),
      ).toThrow(MISSING_BRIDGE_ERROR);
    }
  });

  it("throws when bridge missing", () => {
    const win = window as unknown as { mediaCache?: unknown };
    const hadMediaCache = Object.prototype.hasOwnProperty.call(win, "mediaCache");
    const orig = win.mediaCache;
    delete win.mediaCache;
    try {
      expect(() => resolveMediaCacheBridge({})).toThrow(MISSING_BRIDGE_ERROR);
    } finally {
      if (hadMediaCache) {
        win.mediaCache = orig;
      } else {
        delete win.mediaCache;
      }
    }
  });
});
