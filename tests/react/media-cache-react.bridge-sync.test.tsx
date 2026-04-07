import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MediaCacheProvider } from "../../src/react/index.js";
import { buildStatus, createBridge } from "./helpers/media-cache-fixtures.js";
import { SyncPrimaryErrorProbe } from "./helpers/media-cache-probes.js";

afterEach(() => {
  cleanup();
});

describe("react hooks (bridge sync error)", () => {
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
