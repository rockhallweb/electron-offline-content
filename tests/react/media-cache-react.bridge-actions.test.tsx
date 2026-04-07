import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MediaCacheProvider, useMedia, useMediaBridge } from "../../src/react/index.js";
import { buildStatus, createBridge } from "./helpers/media-cache-fixtures.js";

afterEach(() => {
  cleanup();
});

/** Narrow probe: useMedia with a non-throwing item plus useMediaBridge (avoids error/retry churn with waitFor). */
function BridgeSyncActionProbe() {
  useMedia({ kind: "item", namespace: "nature", id: "forest" });
  const { syncNow, phase } = useMediaBridge();

  return (
    <div>
      <button type="button" onClick={() => void syncNow()}>
        sync-now
      </button>
      <div data-testid="sync-action-phase">{phase}</div>
    </div>
  );
}

describe("react hooks (bridge actions)", () => {
  it("invokes syncNow from useMediaBridge", async () => {
    let syncNowCalls = 0;
    const bridge = createBridge({
      getStatus: async () => buildStatus("ready", 1),
      syncNow: async () => {
        syncNowCalls += 1;
      },
      getItem: async () => null,
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <BridgeSyncActionProbe />
      </MediaCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("sync-action-phase").textContent).toBe("ready");
    });

    await act(async () => {
      screen.getByRole("button", { name: "sync-now" }).click();
    });

    expect(syncNowCalls).toBe(1);
  });
});
