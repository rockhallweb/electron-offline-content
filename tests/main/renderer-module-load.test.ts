import { describe, expect, it } from "vitest";

describe("renderer entry (node)", () => {
  it("loads without hanging", async () => {
    const mod = await import("../../src/renderer/index.js");
    expect(mod.createMediaCacheRenderer).toBeTypeOf("function");
  });

  it("exports framework-agnostic surface", async () => {
    const m = await import("../../src/renderer/index.js");
    expect(m.createMediaCacheRenderer).toBeTypeOf("function");
    expect(m.resolveMediaCacheBridge).toBeTypeOf("function");
    expect(m.aggregateMediaCacheErrors).toBeTypeOf("function");
    expect(m.mediaCacheReadyFromStatus).toBeTypeOf("function");
    expect(m.MISSING_BRIDGE_ERROR).toBeTypeOf("string");
    expect(m.deriveMediaCachePhase).toBeTypeOf("function");
  });
});
