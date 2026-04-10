import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MediaCacheProvider, useMediaAsset, useMediaBridge } from "../../src/react/index.js";
import { buildStatus, createBridge } from "./helpers/media-cache-fixtures.js";

afterEach(() => {
  cleanup();
});

function BridgeSyncActionProbe() {
  useMediaAsset("forest");
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
      getAsset: async () => null,
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
