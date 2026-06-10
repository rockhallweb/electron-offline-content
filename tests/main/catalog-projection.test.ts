import { describe, expect, it, vi } from "vitest";
import { projectResolvedAsset } from "../../src/main/catalog-projection.js";
import type { ActiveAssetRow } from "../../src/main/database.js";
import { DataValidationError } from "../../src/shared/errors.js";

function makeRow(overrides: Partial<ActiveAssetRow> = {}): ActiveAssetRow {
  return {
    generationId: 1,
    assetKey: "abc123",
    displayKey: "nature/forest/main",
    version: "v1",
    mimeType: "video/mp4",
    mediaKind: "video",
    byteLength: 1024,
    metadata: JSON.stringify({ title: "Forest" }),
    indexesJson: JSON.stringify({ tags: ["forest", "ambient"] }),
    relativePath: "blobs/ab/abc123.mp4",
    url: "https://cdn.example.com/forest/main.mp4?token=t1",
    fileStem: "main",
    orderIndex: 0,
    ...overrides,
  };
}

describe("projectResolvedAsset", () => {
  it("maps a validated row to a ResolvedMediaAsset with an offline media:// URL", () => {
    const asset = projectResolvedAsset(makeRow(), {
      devPassthrough: false,
      assetBaseUrlOrigin: null,
    });

    expect(asset).toEqual({
      key: "abc123",
      displayKey: "nature/forest/main",
      version: "v1",
      mimeType: "video/mp4",
      kind: "video",
      byteLength: 1024,
      url: "media://asset/abc123",
      metadata: { title: "Forest" },
      indexes: { tags: ["forest", "ambient"] },
    });
  });

  it("URL-encodes the asset key in offline URLs", () => {
    const asset = projectResolvedAsset(makeRow({ assetKey: "a/b c" }), {
      devPassthrough: false,
      assetBaseUrlOrigin: null,
    });

    expect(asset.url).toBe(`media://asset/${encodeURIComponent("a/b c")}`);
  });

  it("maps a null byteLength to undefined", () => {
    const asset = projectResolvedAsset(makeRow({ byteLength: null }), {
      devPassthrough: false,
      assetBaseUrlOrigin: null,
    });

    expect(asset.byteLength).toBeUndefined();
  });

  it("returns the stored source URL in dev passthrough without an assetBaseUrl origin", () => {
    const asset = projectResolvedAsset(makeRow(), {
      devPassthrough: true,
      assetBaseUrlOrigin: null,
    });

    expect(asset.url).toBe("https://cdn.example.com/forest/main.mp4?token=t1");
  });

  it("rewrites the source URL origin in dev passthrough when assetBaseUrl origin is set", () => {
    const asset = projectResolvedAsset(makeRow(), {
      devPassthrough: true,
      assetBaseUrlOrigin: "http://localhost:8080",
    });

    expect(asset.url).toBe("http://localhost:8080/forest/main.mp4?token=t1");
  });

  it("falls back to the stored URL and warns when the origin override fails", () => {
    const onWarn = vi.fn<(contextLabel: string, err: unknown) => void>();
    const asset = projectResolvedAsset(makeRow({ url: "not-a-valid-url" }), {
      devPassthrough: true,
      assetBaseUrlOrigin: "http://localhost:8080",
      onWarn,
    });

    expect(asset.url).toBe("not-a-valid-url");
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith('asset source for "abc123"', expect.anything());
  });

  it("does not warn when the origin override succeeds", () => {
    const onWarn = vi.fn<(contextLabel: string, err: unknown) => void>();
    projectResolvedAsset(makeRow(), {
      devPassthrough: true,
      assetBaseUrlOrigin: "http://localhost:8080",
      onWarn,
    });

    expect(onWarn).not.toHaveBeenCalled();
  });

  it("throws DataValidationError for corrupted metadata JSON", () => {
    expect(() =>
      projectResolvedAsset(makeRow({ metadata: "{not json" }), {
        devPassthrough: false,
        assetBaseUrlOrigin: null,
      }),
    ).toThrow(DataValidationError);
  });

  it("throws DataValidationError for corrupted indexes JSON", () => {
    expect(() =>
      projectResolvedAsset(makeRow({ indexesJson: "[1, 2, 3]" }), {
        devPassthrough: false,
        assetBaseUrlOrigin: null,
      }),
    ).toThrow(DataValidationError);
  });
});
