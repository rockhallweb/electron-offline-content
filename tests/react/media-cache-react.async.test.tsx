import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MediaCacheProvider } from "../../src/react/index.js";
import type { MediaCacheStatus, ResolvedMediaContentItem } from "../../src/shared/types.js";
import { buildItem, buildStatus, createBridge, deferred } from "./helpers/media-cache-fixtures.js";
import { MediaItemProbe, MediaListProbe, StatusProbe } from "./helpers/media-cache-probes.js";

afterEach(() => {
  cleanup();
});

describe("react hooks (async / list)", () => {
  it("keeps the latest item result when earlier requests resolve late", async () => {
    const firstItem = deferred<ResolvedMediaContentItem | null>();
    const secondItem = deferred<ResolvedMediaContentItem | null>();
    const bridge = createBridge({
      getItem: async (_namespace, id) => (id === "one" ? firstItem.promise : secondItem.promise),
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
});
