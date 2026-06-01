import { describe, expect, it } from "vitest";
import { normalizeFlatManifest } from "../../src/shared/normalize.js";
import { StoreValidationError } from "../../src/shared/errors.js";

describe("normalizeFlatManifest", () => {
  it("validates expiration and produces final manifest invariants", () => {
    const manifest = normalizeFlatManifest({
      snapshotId: "snap",
      retrievedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-02T00:00:00Z",
      indexDefinitions: [
        { name: "gallery", cardinality: "single", required: false, builtin: false },
      ],
      assets: [
        {
          key: "asset-key",
          displayKey: "asset-key",
          version: "v1",
          mimeType: "Video/MP4",
          url: "https://example.test/Folder/Forest Loop.MP4",
          fileName: "Folder/Forest Loop.MP4",
          metadata: { title: "Forest" },
          indexes: { gallery: "nature" },
        },
      ],
    });

    expect(manifest.indexDefinitions).toEqual([
      { name: "gallery", cardinality: "single", required: false, builtin: false },
      { name: "mimeType", cardinality: "single", required: false, builtin: true },
      { name: "mediaKind", cardinality: "single", required: false, builtin: true },
    ]);
    expect(manifest.assets[0]).toMatchObject({
      mediaKind: "video",
      fileStem: "forest loop",
      indexes: {
        gallery: "nature",
        mimeType: "Video/MP4",
        mediaKind: "video",
      },
    });
  });

  it("rejects expiration timestamps without timezone offsets", () => {
    expect(() =>
      normalizeFlatManifest({
        expiresAt: "2026-01-02T00:00:00",
        indexDefinitions: [],
        assets: [],
      }),
    ).toThrow(StoreValidationError);
  });
});
