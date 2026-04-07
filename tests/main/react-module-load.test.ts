import { describe, expect, it } from "vitest";

describe("react entry (node)", () => {
  it("loads without hanging", async () => {
    const mod = await import("../../src/react/index.js");
    expect(mod.MediaCacheProvider).toBeTypeOf("function");
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
