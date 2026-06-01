import { describe, expect, it } from "vitest";
import { DataValidationError } from "../../src/shared/errors.js";
import { projectResolvedMediaAsset } from "../../src/main/catalog-projection.js";
import type { ActiveAssetRow } from "../../src/main/database.js";

describe("projectResolvedMediaAsset", () => {
  it("projects offline assets to media protocol URLs", () => {
    const asset = projectResolvedMediaAsset(row(), {
      devPassthrough: false,
      assetBaseUrlOrigin: null,
    });

    expect(asset).toMatchObject({
      key: "asset/key",
      url: "media://asset/asset%2Fkey",
      metadata: { title: "Forest" },
      indexes: { mimeType: "video/mp4", mediaKind: "video" },
    });
  });

  it("rewrites passthrough asset URLs to the configured assetBaseUrl origin", () => {
    const asset = projectResolvedMediaAsset(
      row({ url: "https://source.example/path/main.mp4?x=1" }),
      {
        devPassthrough: true,
        assetBaseUrlOrigin: "https://cdn.example:8443",
      },
    );

    expect(asset.url).toBe("https://cdn.example:8443/path/main.mp4?x=1");
  });

  it("warns and falls back to the source URL when passthrough URL rewriting fails", () => {
    const warnings: Array<{ label: string; error: unknown }> = [];
    const asset = projectResolvedMediaAsset(row({ url: "not a url" }), {
      devPassthrough: true,
      assetBaseUrlOrigin: "https://cdn.example",
      onWarn: (label, error) => warnings.push({ label, error }),
    });

    expect(asset.url).toBe("not a url");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.label).toBe('asset source for "asset/key"');
  });

  it("keeps row validation for malformed JSON near projection", () => {
    expect(() =>
      projectResolvedMediaAsset(row({ metadata: "{" }), {
        devPassthrough: false,
        assetBaseUrlOrigin: null,
      }),
    ).toThrow(DataValidationError);
  });
});

function row(overrides: Partial<ActiveAssetRow> = {}): ActiveAssetRow {
  return {
    generationId: 1,
    assetKey: "asset/key",
    displayKey: "asset/key",
    version: "v1",
    mimeType: "video/mp4",
    mediaKind: "video",
    byteLength: 9,
    metadata: JSON.stringify({ title: "Forest" }),
    indexesJson: JSON.stringify({ mimeType: "video/mp4", mediaKind: "video" }),
    relativePath: "blobs/asset/key/v1/main.mp4",
    url: "https://source.example/main.mp4",
    fileStem: "main",
    orderIndex: 0,
    ...overrides,
  };
}
