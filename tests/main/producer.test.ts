import { describe, expect, it } from "vitest";
import { defineManifest, defineManifestAsset } from "../../src/main/producer.js";
import { DataValidationError } from "../../src/shared/errors.js";

describe("producer helpers", () => {
  it("defineManifestAsset rejects non-http(s) source URLs", () => {
    expect(() =>
      defineManifestAsset({
        id: "main",
        role: "primary",
        kind: "video",
        source: {
          url: "ftp://example.com/video.mp4",
        },
      }),
    ).toThrow(DataValidationError);
  });

  it("defineManifest rejects manifests with non-http(s) asset URLs", () => {
    expect(() =>
      defineManifest({
        namespaces: [
          {
            key: "nature",
            items: [
              {
                id: "forest",
                version: "v1",
                kind: "video",
                assets: [
                  {
                    id: "main",
                    role: "primary",
                    kind: "video",
                    source: {
                      url: "file:///tmp/video.mp4",
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(DataValidationError);
  });

  it("defineManifestAsset accepts https URLs and derives fileName", () => {
    const asset = defineManifestAsset({
      id: "main",
      role: "primary",
      kind: "video",
      source: {
        url: "https://example.com/media/video.mp4",
      },
    });

    expect(asset.fileName).toBe("video.mp4");
  });

  it("defineManifestAsset rejects empty asset version strings", () => {
    expect(() =>
      defineManifestAsset({
        id: "main",
        role: "primary",
        kind: "video",
        version: "",
        source: {
          url: "https://example.com/media/video.mp4",
        },
      }),
    ).toThrow(DataValidationError);
  });
});
