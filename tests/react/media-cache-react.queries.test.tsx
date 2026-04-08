import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MediaCacheProvider } from "../../src/react/index.js";
import type { MediaCacheStatus } from "../../src/shared/types.js";
import {
  buildAssetWithVersion,
  buildStatus,
  createBridge,
  deferred,
} from "./helpers/media-cache-fixtures.js";
import {
  GlobalErrorsProbe,
  MediaAndBridgePhaseProbe,
  MediaCacheStatusPhaseProbe,
  MediaVersionProbe,
  ReadyAndErrorProbe,
} from "./helpers/media-cache-probes.js";

afterEach(() => {
  cleanup();
});

describe("react hooks (queries / errors)", () => {
  it("refetches asset queries on ready-generation updates by default", async () => {
    let statusListener: ((status: MediaCacheStatus) => void) | null = null;
    let calls = 0;
    const bridge = createBridge({
      getAsset: async () => {
        calls += 1;
        return buildAssetWithVersion("forest", calls === 1 ? "v1" : "v2");
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

  it("allows disabling sync-complete refetch for asset queries", async () => {
    let statusListener: ((status: MediaCacheStatus) => void) | null = null;
    let calls = 0;
    const bridge = createBridge({
      getAsset: async () => {
        calls += 1;
        return buildAssetWithVersion("forest", calls === 1 ? "v1" : "v2");
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

  it("exposes shared status and aggregated errors from useMediaAsset", async () => {
    const bridge = createBridge({
      getStatus: async () => ({
        ...buildStatus("error"),
        error: {
          name: "SyncFailureError",
          code: "SYNC_FAILURE",
          message: "sync failed",
        },
      }),
      getAsset: async () => {
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
      expect(screen.getByTestId("media-status-phase").textContent).toBe("error");
      expect(screen.getByTestId("error-flag").textContent).toBe("true");
      expect(screen.getByTestId("sync-error-code").textContent).toBe("SYNC_FAILURE");
      expect(screen.getByTestId("primary-error-message").textContent).toBe("query failed");
      expect(screen.getByTestId("query-error-count").textContent).toBe("1");
    });
  });

  it("lets useMediaCacheErrors aggregate provider-wide query errors without arguments", async () => {
    const bridge = createBridge({
      getAsset: async () => {
        throw new Error("asset failed");
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
      expect(screen.getByTestId("global-query-error-count").textContent).toBe("2");
      expect(screen.getByTestId("global-primary-error-message").textContent).toBe("asset failed");
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

  it("exposes matching top-level phase from useMediaBridge", async () => {
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
});
