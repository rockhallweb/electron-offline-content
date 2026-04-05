import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MediaCacheProvider,
  useMediaCacheErrors,
  useMediaCacheReady,
  useMediaCacheStatus,
  useMediaItem,
  useMediaItems,
  useMediaNamespace,
  useMediaNamespaceTree,
} from "../../src/react/index.js";
import type {
  MediaCacheBridge,
  MediaCacheStatus,
  ResolvedMediaContentItem,
} from "../../src/shared/types.js";

afterEach(() => {
  cleanup();
});

describe("react hooks", () => {
  it("keeps the latest item result when earlier requests resolve late", async () => {
    const firstItem = deferred<ResolvedMediaContentItem | null>();
    const secondItem = deferred<ResolvedMediaContentItem | null>();
    const bridge = createBridge({
      getItem: async (_namespace, id) => (id === "one" ? firstItem.promise : secondItem.promise),
    });

    const { rerender } = render(
      <MediaCacheProvider bridge={bridge}>
        <ItemProbe namespace="nature" itemId="one" />
      </MediaCacheProvider>,
    );

    rerender(
      <MediaCacheProvider bridge={bridge}>
        <ItemProbe namespace="nature" itemId="two" />
      </MediaCacheProvider>,
    );

    await act(async () => {
      secondItem.resolve(buildItem("two"));
      await secondItem.promise;
    });
    await screen.findByText("two");

    await act(async () => {
      firstItem.resolve(buildItem("one"));
      await firstItem.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("item-id").textContent).toBe("two");
    });
  });

  it("preserves subscribed status updates over stale initial loads", async () => {
    const initialStatus = deferred<MediaCacheStatus>();
    let statusListener: ((status: MediaCacheStatus) => void) | null = null;
    const bridge = createBridge({
      getStatus: async () => initialStatus.promise,
      subscribeStatus: (listener) => {
        statusListener = listener;
        return () => {
          if (statusListener === listener) {
            statusListener = null;
          }
        };
      },
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <StatusProbe />
      </MediaCacheProvider>,
    );

    act(() => {
      statusListener?.(buildStatus("ready"));
    });
    await screen.findByText("ready");

    await act(async () => {
      initialStatus.resolve(buildStatus("idle"));
      await initialStatus.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("status-phase").textContent).toBe("ready");
    });
  });

  it("uses flat and recursive list queries via useMediaItems", async () => {
    let listNamespaceCalls = 0;
    let listNamespaceTreeCalls = 0;
    const bridge = createBridge({
      listNamespace: async () => {
        listNamespaceCalls += 1;
        return { items: [buildItem("flat")], nextCursor: null };
      },
      listNamespaceTree: async () => {
        listNamespaceTreeCalls += 1;
        return { items: [buildItem("tree")], nextCursor: null };
      },
    });

    const { rerender } = render(
      <MediaCacheProvider bridge={bridge}>
        <ItemsProbe namespace="nature" recursive={false} />
      </MediaCacheProvider>,
    );

    await screen.findByText("flat");
    expect(listNamespaceCalls).toBeGreaterThan(0);
    expect(listNamespaceTreeCalls).toBe(0);

    rerender(
      <MediaCacheProvider bridge={bridge}>
        <ItemsProbe namespace="nature" recursive />
      </MediaCacheProvider>,
    );
    await screen.findByText("tree");
    expect(listNamespaceTreeCalls).toBeGreaterThan(0);
  });

  it("keeps legacy list hooks as wrappers around useMediaItems", async () => {
    let listNamespaceCalls = 0;
    let listNamespaceTreeCalls = 0;
    const bridge = createBridge({
      listNamespace: async () => {
        listNamespaceCalls += 1;
        return { items: [buildItem("legacy-flat")], nextCursor: null };
      },
      listNamespaceTree: async () => {
        listNamespaceTreeCalls += 1;
        return { items: [buildItem("legacy-tree")], nextCursor: null };
      },
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <LegacyListProbe />
      </MediaCacheProvider>,
    );

    await screen.findByText("legacy-flat");
    await screen.findByText("legacy-tree");
    expect(listNamespaceCalls).toBeGreaterThan(0);
    expect(listNamespaceTreeCalls).toBeGreaterThan(0);
  });

  it("refetches item queries on ready-generation updates by default", async () => {
    let statusListener: ((status: MediaCacheStatus) => void) | null = null;
    let calls = 0;
    const bridge = createBridge({
      getItem: async () => {
        calls += 1;
        return buildItemWithVersion("forest", calls === 1 ? "v1" : "v2");
      },
      subscribeStatus: (listener) => {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      },
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <ItemVersionProbe namespace="nature" itemId="forest" />
      </MediaCacheProvider>,
    );

    await screen.findByText("v1");
    act(() => {
      statusListener?.(buildStatus("ready", 1));
    });
    await screen.findByText("v2");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("allows disabling sync-complete refetch for item queries", async () => {
    let statusListener: ((status: MediaCacheStatus) => void) | null = null;
    let calls = 0;
    const bridge = createBridge({
      getItem: async () => {
        calls += 1;
        return buildItemWithVersion("forest", calls === 1 ? "v1" : "v2");
      },
      subscribeStatus: (listener) => {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      },
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <ItemVersionProbe namespace="nature" itemId="forest" refetchOnSyncComplete={false} />
      </MediaCacheProvider>,
    );

    await screen.findByText("v1");
    act(() => {
      statusListener?.(buildStatus("ready", 1));
    });
    await waitFor(() => {
      expect(screen.getByTestId("item-version").textContent).toBe("v1");
    });
    expect(calls).toBe(1);
  });

  it("exposes derived readiness and aggregated errors", async () => {
    const bridge = createBridge({
      getStatus: async () => ({
        ...buildStatus("error"),
        error: {
          name: "SyncFailureError",
          code: "SYNC_FAILURE",
          message: "sync failed",
        },
      }),
      getItem: async () => {
        throw new Error("query failed");
      },
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <ReadyAndErrorProbe />
      </MediaCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready-flag").textContent).toBe("false");
      expect(screen.getByTestId("error-flag").textContent).toBe("true");
      expect(screen.getByTestId("sync-error-code").textContent).toBe("SYNC_FAILURE");
      expect(screen.getByTestId("primary-error-message").textContent).toBe("query failed");
      expect(screen.getByTestId("query-error-count").textContent).toBe("1");
    });
  });

  it("lets useMediaCacheErrors reuse a caller-provided status subscription", async () => {
    let subscribeStatusCalls = 0;
    const bridge = createBridge({
      getStatus: async () => buildStatus("ready", 1),
      subscribeStatus: () => {
        subscribeStatusCalls += 1;
        return () => undefined;
      },
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <StatusBackedErrorProbe />
      </MediaCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("status-backed-error-ready").textContent).toBe("ready");
    });
    expect(subscribeStatusCalls).toBe(1);
  });

  it("converts sync errors into Error primaryError values", async () => {
    const bridge = createBridge({
      getStatus: async () => ({
        ...buildStatus("error"),
        error: {
          name: "SyncFailureError",
          code: "SYNC_FAILURE",
          message: "sync failed",
        },
      }),
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <SyncPrimaryErrorProbe />
      </MediaCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("sync-primary-error-name").textContent).toBe("SyncFailureError");
      expect(screen.getByTestId("sync-primary-error-message").textContent).toBe("sync failed");
    });
  });
});

function ItemProbe({ namespace, itemId }: { namespace: string; itemId: string }) {
  const item = useMediaItem(namespace, itemId);
  return <div data-testid="item-id">{item.data?.id ?? "loading"}</div>;
}

function ItemVersionProbe({
  namespace,
  itemId,
  refetchOnSyncComplete,
}: {
  namespace: string;
  itemId: string;
  refetchOnSyncComplete?: boolean;
}) {
  const item = useMediaItem(namespace, itemId, { refetchOnSyncComplete });
  return <div data-testid="item-version">{item.data?.version ?? "loading"}</div>;
}

function ItemsProbe({ namespace, recursive }: { namespace: string; recursive: boolean }) {
  const items = useMediaItems(namespace, { recursive });
  return <div>{items.data?.items[0]?.id ?? "loading"}</div>;
}

function LegacyListProbe() {
  const namespace = useMediaNamespace("nature", { limit: 10 });
  const tree = useMediaNamespaceTree("nature", { limit: 10 });
  return (
    <div>
      <div>{namespace.data?.items[0]?.id ?? "loading-flat"}</div>
      <div>{tree.data?.items[0]?.id ?? "loading-tree"}</div>
    </div>
  );
}

function StatusProbe() {
  const status = useMediaCacheStatus();
  return <div data-testid="status-phase">{status.data?.phase ?? "loading"}</div>;
}

function ReadyAndErrorProbe() {
  const status = useMediaCacheStatus();
  const ready = useMediaCacheReady();
  const item = useMediaItem("nature", "forest");
  const errors = useMediaCacheErrors(status, item);

  return (
    <div>
      <div data-testid="ready-flag">{String(ready.data?.ready ?? false)}</div>
      <div data-testid="error-flag">{String(errors.hasError)}</div>
      <div data-testid="sync-error-code">{errors.syncError?.code ?? "none"}</div>
      <div data-testid="primary-error-message">{errors.primaryError?.message ?? "none"}</div>
      <div data-testid="query-error-count">{String(errors.queryErrors.length)}</div>
    </div>
  );
}

function StatusBackedErrorProbe() {
  const status = useMediaCacheStatus();
  const errors = useMediaCacheErrors(status);

  return (
    <div data-testid="status-backed-error-ready">
      {errors.hasError ? "error" : (status.data?.phase ?? "loading")}
    </div>
  );
}

function SyncPrimaryErrorProbe() {
  const status = useMediaCacheStatus();
  const errors = useMediaCacheErrors(status);

  return (
    <div>
      <div data-testid="sync-primary-error-name">{errors.primaryError?.name ?? "none"}</div>
      <div data-testid="sync-primary-error-message">{errors.primaryError?.message ?? "none"}</div>
    </div>
  );
}

function createBridge(overrides: Partial<MediaCacheBridge> = {}): MediaCacheBridge {
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

function buildItem(id: string): ResolvedMediaContentItem {
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

function buildItemWithVersion(id: string, version: string): ResolvedMediaContentItem {
  return {
    ...buildItem(id),
    version,
  };
}

function buildStatus(phase: MediaCacheStatus["phase"], activeGenerationId = 0): MediaCacheStatus {
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

function deferred<T>() {
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
