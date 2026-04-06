import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MediaCacheProvider,
  useFileStemMatch,
  useMedia,
  useMediaBridge,
  useMediaCacheErrors,
  useMediaCacheReady,
  useMediaCacheStatus,
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
      getItem: async (_namespace, id) =>
        id === "one" ? firstItem.promise : secondItem.promise,
    });

    const { rerender } = render(
      <MediaCacheProvider bridge={bridge}>
        <MediaItemProbe itemId="one" />
      </MediaCacheProvider>,
    );

    rerender(
      <MediaCacheProvider bridge={bridge}>
        <MediaItemProbe itemId="two" />
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

  it("uses flat and recursive list queries via useMedia", async () => {
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
        <MediaListProbe recursive={false} />
      </MediaCacheProvider>,
    );

    await screen.findByText("flat");
    expect(listNamespaceCalls).toBeGreaterThan(0);
    expect(listNamespaceTreeCalls).toBe(0);

    rerender(
      <MediaCacheProvider bridge={bridge}>
        <MediaListProbe recursive />
      </MediaCacheProvider>,
    );

    await screen.findByText("tree");
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
        <MediaVersionProbe refetchOnSyncComplete />
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
        <MediaVersionProbe refetchOnSyncComplete={false} />
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

  it("exposes shared status and aggregated errors from useMedia", async () => {
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
      expect(screen.getByTestId("media-status-phase").textContent).toBe(
        "error",
      );
      expect(screen.getByTestId("error-flag").textContent).toBe("true");
      expect(screen.getByTestId("sync-error-code").textContent).toBe(
        "SYNC_FAILURE",
      );
      expect(screen.getByTestId("primary-error-message").textContent).toBe(
        "query failed",
      );
      expect(screen.getByTestId("query-error-count").textContent).toBe("1");
    });
  });

  it("lets useMediaCacheErrors aggregate provider-wide query errors without arguments", async () => {
    const bridge = createBridge({
      getItem: async () => {
        throw new Error("item failed");
      },
      findByFileStem: async () => {
        throw new Error("stem failed");
      },
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <GlobalErrorsProbe />
      </MediaCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("global-query-error-count").textContent).toBe(
        "2",
      );
      expect(
        screen.getByTestId("global-primary-error-message").textContent,
      ).toBe("item failed");
    });
  });

  it("exposes top-level loading phase from useMediaCacheStatus before first snapshot", async () => {
    const initialStatus = deferred<MediaCacheStatus>();
    const bridge = createBridge({
      getStatus: async () => initialStatus.promise,
      subscribeStatus: () => () => undefined,
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <MediaCacheStatusPhaseProbe />
      </MediaCacheProvider>,
    );

    expect(screen.getByTestId("status-hook-phase").textContent).toBe("loading");

    await act(async () => {
      initialStatus.resolve(buildStatus("idle"));
      await initialStatus.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("status-hook-phase").textContent).toBe("idle");
    });
  });

  it("exposes matching top-level phase from useMediaBridge and useMedia", async () => {
    const bridge = createBridge({
      getStatus: async () => buildStatus("syncing"),
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <MediaAndBridgePhaseProbe />
      </MediaCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("media-phase").textContent).toBe("syncing");
      expect(screen.getByTestId("bridge-phase").textContent).toBe("syncing");
    });
  });

  it("exposes bridge methods, status, and aggregated errors from useMediaBridge", async () => {
    let syncNowCalls = 0;
    const bridge = createBridge({
      getStatus: async () => buildStatus("ready", 1),
      syncNow: async () => {
        syncNowCalls += 1;
      },
      getItem: async () => {
        throw new Error("bridge query failed");
      },
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <BridgeProbe />
      </MediaCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("bridge-status-phase").textContent).toBe(
        "ready",
      );
      expect(screen.getByTestId("bridge-query-error-count").textContent).toBe(
        "1",
      );
      expect(
        screen.getByTestId("bridge-primary-error-message").textContent,
      ).toBe("bridge query failed");
    });

    await act(async () => {
      screen.getByRole("button", { name: "sync-now" }).click();
    });

    expect(syncNowCalls).toBe(1);
  });

  it("uses one provider status subscription for media and error state", async () => {
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
        <ProviderRuntimeProbe />
      </MediaCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("provider-runtime-phase").textContent).toBe(
        "ready",
      );
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
      expect(screen.getByTestId("sync-primary-error-name").textContent).toBe(
        "SyncFailureError",
      );
      expect(screen.getByTestId("sync-primary-error-message").textContent).toBe(
        "sync failed",
      );
    });
  });

  it("does not export removed media query hooks", async () => {
    const reactModule = await import("../../src/react/index.js");
    expect("useMediaItem" in reactModule).toBe(false);
    expect("useMediaItems" in reactModule).toBe(false);
    expect("useMediaNamespace" in reactModule).toBe(false);
    expect("useMediaNamespaceTree" in reactModule).toBe(false);
    expect("useMediaCacheBridge" in reactModule).toBe(false);
    expect("useMediaBridge" in reactModule).toBe(true);
  });
});

function MediaItemProbe({ itemId }: { itemId: string }) {
  const item = useMedia({ kind: "item", namespace: "nature", id: itemId });
  return <div data-testid="item-id">{item.data?.id ?? "loading"}</div>;
}

function MediaVersionProbe({
  refetchOnSyncComplete,
}: {
  refetchOnSyncComplete?: boolean;
}) {
  const item = useMedia({
    kind: "item",
    namespace: "nature",
    id: "forest",
    refetchOnSyncComplete,
  });
  return (
    <div data-testid="item-version">{item.data?.version ?? "loading"}</div>
  );
}

function MediaListProbe({ recursive }: { recursive: boolean }) {
  const items = useMedia({ kind: "list", namespace: "nature", recursive });
  return <div>{items.data?.items[0]?.id ?? "loading"}</div>;
}

function StatusProbe() {
  const status = useMediaCacheStatus();
  return <div data-testid="status-phase">{status.phase}</div>;
}

function MediaCacheStatusPhaseProbe() {
  const status = useMediaCacheStatus();
  return <div data-testid="status-hook-phase">{status.phase}</div>;
}

function MediaAndBridgePhaseProbe() {
  const media = useMedia({ kind: "item", namespace: "nature", id: "forest" });
  const bridge = useMediaBridge();
  return (
    <div>
      <div data-testid="media-phase">{media.phase}</div>
      <div data-testid="bridge-phase">{bridge.phase}</div>
    </div>
  );
}

function ReadyAndErrorProbe() {
  const ready = useMediaCacheReady();
  const media = useMedia({ kind: "item", namespace: "nature", id: "forest" });
  const errors = useMediaCacheErrors();

  return (
    <div>
      <div data-testid="ready-flag">{String(ready.data?.ready ?? false)}</div>
      <div data-testid="media-status-phase">{media.phase}</div>
      <div data-testid="error-flag">{String(errors.hasError)}</div>
      <div data-testid="sync-error-code">
        {errors.syncError?.code ?? "none"}
      </div>
      <div data-testid="primary-error-message">
        {errors.primaryError?.message ?? "none"}
      </div>
      <div data-testid="query-error-count">
        {String(errors.queryErrors.length)}
      </div>
    </div>
  );
}

function GlobalErrorsProbe() {
  useMedia({ kind: "item", namespace: "nature", id: "forest" });
  useFileStemMatch("forest");
  const errors = useMediaCacheErrors();

  return (
    <div>
      <div data-testid="global-query-error-count">
        {String(errors.queryErrors.length)}
      </div>
      <div data-testid="global-primary-error-message">
        {errors.primaryError?.message ?? "none"}
      </div>
    </div>
  );
}

function BridgeProbe() {
  useMedia({ kind: "item", namespace: "nature", id: "forest" });
  const { syncNow, phase, errors } = useMediaBridge();

  return (
    <div>
      <button type="button" onClick={() => void syncNow()}>
        sync-now
      </button>
      <div data-testid="bridge-status-phase">{phase}</div>
      <div data-testid="bridge-query-error-count">
        {String(errors.queryErrors.length)}
      </div>
      <div data-testid="bridge-primary-error-message">
        {errors.primaryError?.message ?? "none"}
      </div>
    </div>
  );
}

function ProviderRuntimeProbe() {
  const media = useMedia({ kind: "item", namespace: "nature", id: "forest" });
  const errors = useMediaCacheErrors();

  return (
    <div data-testid="provider-runtime-phase">
      {errors.hasError ? "error" : media.phase}
    </div>
  );
}

function SyncPrimaryErrorProbe() {
  const errors = useMediaCacheErrors();

  return (
    <div>
      <div data-testid="sync-primary-error-name">
        {errors.primaryError?.name ?? "none"}
      </div>
      <div data-testid="sync-primary-error-message">
        {errors.primaryError?.message ?? "none"}
      </div>
    </div>
  );
}

function createBridge(
  overrides: Partial<MediaCacheBridge> = {},
): MediaCacheBridge {
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

function buildItemWithVersion(
  id: string,
  version: string,
): ResolvedMediaContentItem {
  return {
    ...buildItem(id),
    version,
  };
}

function buildStatus(
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
