import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MediaCacheProvider } from "../../src/react/index.js";
import { buildStatus, createBridge } from "./helpers/media-cache-fixtures.js";
import { ProviderRuntimeProbe } from "./helpers/media-cache-probes.js";

afterEach(() => {
  cleanup();
});

describe("react hooks (provider subscription)", () => {
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
      expect(screen.getByTestId("provider-runtime-phase").textContent).toBe("ready");
    });
    expect(subscribeStatusCalls).toBe(1);
  });
});
