import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MediaCacheProvider, useMediaAsset } from "../../src/react/index.js";
import type { ResolvedMediaAsset } from "../../src/shared/types.js";
import { buildAsset, createBridge, deferred } from "./helpers/media-cache-fixtures.js";

afterEach(() => {
  cleanup();
});

function AsyncLoadingProbe() {
  const result = useMediaAsset("forest");
  return (
    <div>
      <div data-testid="loading">{String(result.loading)}</div>
      <div data-testid="data">{result.data?.key ?? "null"}</div>
    </div>
  );
}

function AsyncErrorProbe() {
  const result = useMediaAsset("forest");
  return (
    <div>
      <div data-testid="error">{result.error?.message ?? "none"}</div>
    </div>
  );
}

describe("react hooks (async)", () => {
  it("shows loading state before getAsset resolves", async () => {
    const assetDeferred = deferred<ResolvedMediaAsset | null>();
    const bridge = createBridge({
      getAsset: async () => assetDeferred.promise,
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <AsyncLoadingProbe />
      </MediaCacheProvider>,
    );

    expect(screen.getByTestId("loading").textContent).toBe("true");
    expect(screen.getByTestId("data").textContent).toBe("null");

    await act(async () => {
      assetDeferred.resolve(buildAsset("forest"));
      await assetDeferred.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
      expect(screen.getByTestId("data").textContent).toBe("forest");
    });
  });

  it("shows error state when getAsset rejects", async () => {
    const bridge = createBridge({
      getAsset: async () => {
        throw new Error("fetch failed");
      },
    });

    render(
      <MediaCacheProvider bridge={bridge}>
        <AsyncErrorProbe />
      </MediaCacheProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe("fetch failed");
    });
  });
});
