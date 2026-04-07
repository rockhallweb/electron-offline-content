import { describe, expect, it } from "vitest";
import {
  assetsFromEntries,
  defineAsset,
  defineItem,
  defineManifest,
  itemsFromEntries,
  namespacesFromEntries,
} from "../../src/main/producer.js";
import { DataValidationError, ManifestValidationError } from "../../src/shared/errors.js";

describe("producer helpers", () => {
  it("defineAsset rejects non-http(s) source URLs", () => {
    expect(() =>
      defineAsset({
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
        namespaces: {
          nature: {
            items: {
              forest: {
                version: "v1",
                kind: "video",
                assets: {
                  main: {
                    role: "primary",
                    kind: "video",
                    source: {
                      url: "file:///tmp/video.mp4",
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow(DataValidationError);
  });

  it("defineAsset accepts https URLs and derives fileName", () => {
    const asset = defineAsset({
      role: "primary",
      kind: "video",
      source: {
        url: "https://example.com/media/video.mp4",
      },
    });

    expect(asset.fileName).toBe("video.mp4");
  });

  it("defineAsset rejects empty asset version strings", () => {
    expect(() =>
      defineAsset({
        role: "primary",
        kind: "video",
        version: "",
        source: {
          url: "https://example.com/media/video.mp4",
        },
      }),
    ).toThrow(DataValidationError);
  });

  it("defineItem accepts valid item input unchanged", () => {
    const item = defineItem({
      version: "v1",
      kind: "video",
      assets: {
        main: {
          role: "primary",
          kind: "video",
          source: {
            url: "https://example.com/media/video.mp4",
          },
        },
      },
    });

    expect(item.version).toBe("v1");
    expect(Object.keys(item.assets)).toEqual(["main"]);
  });

  it("defineItem rejects invalid item input", () => {
    expect(() =>
      defineItem({
        version: "",
        kind: "video",
        assets: {
          main: {
            role: "primary",
            kind: "video",
            source: { url: "https://example.com/a.mp4" },
          },
        },
      }),
    ).toThrow(DataValidationError);
  });

  it("itemsFromEntries detects duplicate keys", () => {
    expect(() =>
      itemsFromEntries(["a", "b"], () => ["dup", { version: "1", kind: "video", assets: {} }]),
    ).toThrow(ManifestValidationError);
  });

  it("assetsFromEntries detects duplicate keys", () => {
    expect(() =>
      assetsFromEntries([1, 2], () => [
        "same",
        { role: "primary", kind: "video", source: { url: "https://example.com/a.mp4" } },
      ]),
    ).toThrow(ManifestValidationError);
  });

  it("namespacesFromEntries detects duplicate keys", () => {
    expect(() =>
      namespacesFromEntries([1, 2], () => [
        "ns",
        { items: { x: { version: "1", kind: "video", assets: {} } } },
      ]),
    ).toThrow(ManifestValidationError);
  });

  it("itemsFromEntries returns empty record for empty source", () => {
    expect(itemsFromEntries([], () => ["x", { version: "1", kind: "video", assets: {} }])).toEqual(
      {},
    );
  });
});
