import { describe, expect, it } from "vitest";

describe("react entry (node)", () => {
  it("loads without hanging", async () => {
    const mod = await import("../../src/react/index.js");
    expect(mod.MediaCacheProvider).toBeTypeOf("function");
  });

  it("exports new flat-store query hooks", async () => {
    const reactModule = await import("../../src/react/index.js");
    expect("useMediaAsset" in reactModule).toBe(true);
    expect("useMediaByIndex" in reactModule).toBe(true);
    expect("useFileStemMatch" in reactModule).toBe(true);
    expect("useMediaBridge" in reactModule).toBe(true);
    expect("useMediaCacheStatus" in reactModule).toBe(true);
    expect("useMediaCacheReady" in reactModule).toBe(true);
    expect("useMediaCacheErrors" in reactModule).toBe(true);
  });

  it("does not export removed legacy hooks", async () => {
    const reactModule = await import("../../src/react/index.js");
    expect("useMedia" in reactModule).toBe(false);
    expect("useMediaItem" in reactModule).toBe(false);
    expect("useMediaItems" in reactModule).toBe(false);
    expect("useMediaNamespace" in reactModule).toBe(false);
    expect("useMediaNamespaceTree" in reactModule).toBe(false);
    expect("useMediaCacheBridge" in reactModule).toBe(false);
  });
});
