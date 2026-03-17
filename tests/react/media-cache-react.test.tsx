import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MediaCacheProvider, useMediaCacheStatus, useMediaItem } from "../../src/react/index.js";
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
});

function ItemProbe({ namespace, itemId }: { namespace: string; itemId: string }) {
  const item = useMediaItem(namespace, itemId);
  return <div data-testid="item-id">{item.data?.id ?? "loading"}</div>;
}

function StatusProbe() {
  const status = useMediaCacheStatus();
  return <div data-testid="status-phase">{status.data?.phase ?? "loading"}</div>;
}

function createBridge(overrides: Partial<MediaCacheBridge> = {}): MediaCacheBridge {
  return {
    getStatus: async () => buildStatus("idle"),
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
  };
}

function buildStatus(phase: MediaCacheStatus["phase"]): MediaCacheStatus {
  return {
    phase,
    activeGenerationId: phase === "ready" ? 1 : null,
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
