import { describe, expect, it } from "vitest";
import { hashKey } from "../../src/internal/asset-key.js";
import { createMediaStore, MediaStore } from "../../src/main/store.js";
import { StoreValidationError } from "../../src/shared/errors.js";
import { IndexTag } from "../../src/shared/types.js";

describe("createMediaStore", () => {
  it("returns a MediaStore instance with no options", () => {
    const store = createMediaStore();
    expect(store).toBeInstanceOf(MediaStore);
  });

  it("returns a MediaStore instance with all options", () => {
    const store = createMediaStore({
      snapshotId: "snap-1",
      retrievedAt: "2025-01-01T00:00:00Z",
      expiresAt: "2025-12-31T23:59:59Z",
    });
    expect(store).toBeInstanceOf(MediaStore);
  });

  it("passes options through to serialized output", () => {
    const store = createMediaStore({
      snapshotId: "snap-42",
      retrievedAt: "2025-06-01T00:00:00Z",
      expiresAt: "2025-06-02T00:00:00Z",
    });
    const manifest = store._serialize();
    expect(manifest.snapshotId).toBe("snap-42");
    expect(manifest.retrievedAt).toBe("2025-06-01T00:00:00Z");
    expect(manifest.expiresAt).toBe("2025-06-02T00:00:00Z");
  });

  it("leaves optional fields undefined when omitted", () => {
    const store = createMediaStore();
    const manifest = store._serialize();
    expect(manifest.snapshotId).toBeUndefined();
    expect(manifest.retrievedAt).toBeUndefined();
    expect(manifest.expiresAt).toBeUndefined();
  });
});

describe("store.defineIndex", () => {
  it("returns a callable MediaIndex with default single cardinality and not required", () => {
    const store = createMediaStore();
    const idx = store.defineIndex("gallery");
    expect(typeof idx).toBe("function");
    expect(idx.indexName).toBe("gallery");
    expect(idx.cardinality).toBe("single");
    expect(idx.required).toBe(false);
  });

  it("supports multi cardinality", () => {
    const store = createMediaStore();
    const idx = store.defineIndex("tags", { cardinality: "multi" });
    expect(idx.cardinality).toBe("multi");
  });

  it("supports required option", () => {
    const store = createMediaStore();
    const idx = store.defineIndex("category", { required: true });
    expect(idx.required).toBe(true);
  });

  it("supports both cardinality and required together", () => {
    const store = createMediaStore();
    const idx = store.defineIndex("labels", { cardinality: "multi", required: true });
    expect(idx.cardinality).toBe("multi");
    expect(idx.required).toBe(true);
  });

  it("rejects empty index name", () => {
    const store = createMediaStore();
    expect(() => store.defineIndex("")).toThrow(StoreValidationError);
  });

  it("rejects duplicate index name", () => {
    const store = createMediaStore();
    store.defineIndex("gallery");
    expect(() => store.defineIndex("gallery")).toThrow(StoreValidationError);
    expect(() => store.defineIndex("gallery")).toThrow(/Duplicate index name "gallery"/);
  });

  it("rejects reserved name mimeType", () => {
    const store = createMediaStore();
    expect(() => store.defineIndex("mimeType")).toThrow(StoreValidationError);
    expect(() => store.defineIndex("mimeType")).toThrow(/reserved/);
  });

  it("rejects reserved name mediaKind", () => {
    const store = createMediaStore();
    expect(() => store.defineIndex("mediaKind")).toThrow(StoreValidationError);
    expect(() => store.defineIndex("mediaKind")).toThrow(/reserved/);
  });

  it("allows multiple distinct indexes", () => {
    const store = createMediaStore();
    const a = store.defineIndex("alpha");
    const b = store.defineIndex("beta");
    expect(a.indexName).toBe("alpha");
    expect(b.indexName).toBe("beta");
  });
});

describe("store.add", () => {
  function makeStore() {
    const store = createMediaStore();
    const gallery = store.defineIndex("gallery");
    const tags = store.defineIndex("tags", { cardinality: "multi" });
    return { store, gallery, tags };
  }

  const validAsset = {
    version: "v1",
    mimeType: "image/jpeg",
    url: "https://cdn.example.com/photo-1.jpg",
  };

  it("accepts a valid asset with no indexes", () => {
    const { store } = makeStore();
    expect(() => store.add("photo-1", validAsset)).not.toThrow();
  });

  it("accepts a valid asset with single-cardinality index", () => {
    const { store, gallery } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        indexes: [gallery("nature")],
      }),
    ).not.toThrow();
  });

  it("accepts a valid asset with multi-cardinality index", () => {
    const { store, tags } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        indexes: [tags(["forest", "ambient"])],
      }),
    ).not.toThrow();
  });

  it("accepts a multi-cardinality index with a single string value", () => {
    const { store, tags } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        indexes: [tags("single-tag")],
      }),
    ).not.toThrow();
  });

  it("accepts http URLs", () => {
    const { store } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        url: "http://cdn.example.com/photo-1.jpg",
      }),
    ).not.toThrow();
  });

  it("accepts assets with metadata and byteLength", () => {
    const { store } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        byteLength: 1024,
        metadata: { title: "Forest", rating: 5 },
      }),
    ).not.toThrow();
  });

  it("accepts assets with explicit fileName", () => {
    const { store } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        fileName: "custom-name.jpg",
      }),
    ).not.toThrow();
  });

  it("rejects empty asset key", () => {
    const { store } = makeStore();
    expect(() => store.add("", validAsset)).toThrow(StoreValidationError);
    expect(() => store.add("", validAsset)).toThrow(/non-empty/);
  });

  it("rejects duplicate asset key", () => {
    const { store } = makeStore();
    store.add("photo-1", validAsset);
    expect(() => store.add("photo-1", validAsset)).toThrow(StoreValidationError);
    expect(() =>
      store.add("photo-1", { ...validAsset, url: "https://cdn.example.com/other.jpg" }),
    ).toThrow(/Duplicate asset key "photo-1"/);
  });

  it("rejects missing version", () => {
    const { store } = makeStore();
    expect(() => store.add("photo-1", { ...validAsset, version: "" })).toThrow(
      StoreValidationError,
    );
  });

  it("rejects invalid mimeType (missing subtype)", () => {
    const { store } = makeStore();
    expect(() => store.add("photo-1", { ...validAsset, mimeType: "image" })).toThrow(
      StoreValidationError,
    );
  });

  it("rejects empty mimeType", () => {
    const { store } = makeStore();
    expect(() => store.add("photo-1", { ...validAsset, mimeType: "" })).toThrow(
      StoreValidationError,
    );
  });

  it("rejects non-http(s) source URL", () => {
    const { store } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        url: "ftp://example.com/photo.jpg",
      }),
    ).toThrow(StoreValidationError);
  });

  it("rejects file:// source URL", () => {
    const { store } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        url: "file:///tmp/photo.jpg",
      }),
    ).toThrow(StoreValidationError);
  });

  it("rejects invalid source URL", () => {
    const { store } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        url: "not a url",
      }),
    ).toThrow(StoreValidationError);
  });

  it("rejects missing source URL", () => {
    const { store } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        url: "",
      }),
    ).toThrow(StoreValidationError);
  });

  it("rejects non-array indexes", () => {
    const { store } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        indexes: {} as never,
      }),
    ).toThrow(/indexes must be an array of IndexTag/);
  });

  it("rejects unknown index reference", () => {
    const { store } = makeStore();
    const unknownTag = new IndexTag("unknown", "value");
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        indexes: [unknownTag],
      }),
    ).toThrow(StoreValidationError);
    expect(() =>
      store.add("photo-2", {
        ...validAsset,
        indexes: [unknownTag],
      }),
    ).toThrow(/has not been defined/);
  });

  it("rejects array value for single-cardinality index", () => {
    const { store, gallery } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        indexes: [gallery(["a", "b"] as unknown as string)],
      }),
    ).toThrow(StoreValidationError);
    expect(() =>
      store.add("photo-2", {
        ...validAsset,
        indexes: [gallery(["a", "b"] as unknown as string)],
      }),
    ).toThrow(/single cardinality/);
  });

  it("rejects empty array for multi-cardinality index", () => {
    const { store, tags } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        indexes: [tags([])],
      }),
    ).toThrow(StoreValidationError);
    expect(() =>
      store.add("photo-2", {
        ...validAsset,
        indexes: [tags([])],
      }),
    ).toThrow(/must not be empty/);
  });

  it("rejects empty string value for single-cardinality index", () => {
    const { store, gallery } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        indexes: [gallery("")],
      }),
    ).toThrow(StoreValidationError);
  });

  it("rejects empty string inside multi-cardinality array", () => {
    const { store, tags } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        indexes: [tags(["valid", ""])],
      }),
    ).toThrow(StoreValidationError);
  });

  it("rejects duplicate index names in the array", () => {
    const { store, gallery } = makeStore();
    expect(() =>
      store.add("photo-1", {
        ...validAsset,
        indexes: [gallery("nature"), gallery("urban")],
      }),
    ).toThrow(StoreValidationError);
    expect(() =>
      store.add("photo-2", {
        ...validAsset,
        indexes: [gallery("nature"), gallery("urban")],
      }),
    ).toThrow(/duplicate index/);
  });
});

describe("store._serialize", () => {
  it("produces correct output shape for an empty store", () => {
    const store = createMediaStore({ snapshotId: "empty" });
    const manifest = store._serialize();
    expect(manifest.snapshotId).toBe("empty");
    expect(manifest.assets).toEqual([]);
    expect(manifest.indexDefinitions).toEqual([
      { name: "mimeType", cardinality: "single", required: false, builtin: true },
      { name: "mediaKind", cardinality: "single", required: false, builtin: true },
    ]);
  });

  it("includes user-defined indexes before built-in indexes", () => {
    const store = createMediaStore();
    store.defineIndex("gallery");
    store.defineIndex("tags", { cardinality: "multi", required: true });
    const manifest = store._serialize();
    const names = manifest.indexDefinitions.map((d) => d.name);
    expect(names).toEqual(["gallery", "tags", "mimeType", "mediaKind"]);
  });

  it("auto-populates mimeType and mediaKind indexes on each asset", () => {
    const store = createMediaStore();
    store.add("video-1", {
      version: "v1",
      mimeType: "video/mp4",
      url: "https://cdn.example.com/clip.mp4",
    });
    const manifest = store._serialize();
    const asset = manifest.assets[0]!;
    expect(asset.indexes.mimeType).toBe("video/mp4");
    expect(asset.indexes.mediaKind).toBe("video");
    expect(asset.mediaKind).toBe("video");
  });

  it("derives mediaKind correctly for various MIME types", () => {
    const store = createMediaStore();

    const cases: Array<[string, string, string]> = [
      ["img", "image/png", "image"],
      ["aud", "audio/mpeg", "audio"],
      ["doc", "application/pdf", "document"],
      ["html", "text/html", "html"],
      ["txt", "text/plain", "text"],
      ["json", "application/json", "text"],
      ["bin", "application/octet-stream", "binary"],
    ];

    for (const [key, mime, _expectedKind] of cases) {
      store.add(key, {
        version: "v1",
        mimeType: mime,
        url: `https://cdn.example.com/${key}.bin`,
      });
    }

    const manifest = store._serialize();
    for (const [key, , expectedKind] of cases) {
      const asset = manifest.assets.find((a) => a.displayKey === key);
      expect(asset?.key).toBe(hashKey(key));
      expect(asset?.mediaKind).toBe(expectedKind);
      expect(asset?.indexes.mediaKind).toBe(expectedKind);
    }
  });

  it("derives fileName from source URL when not explicitly set", () => {
    const store = createMediaStore();
    store.add("photo-1", {
      version: "v1",
      mimeType: "image/jpeg",
      url: "https://cdn.example.com/media/photo-1.jpg",
    });
    const manifest = store._serialize();
    expect(manifest.assets[0]!.fileName).toBe("photo-1.jpg");
    expect(manifest.assets[0]!.fileStem).toBe("photo-1");
  });

  it("uses explicit fileName when provided", () => {
    const store = createMediaStore();
    store.add("photo-1", {
      version: "v1",
      mimeType: "image/jpeg",
      fileName: "custom.jpg",
      url: "https://cdn.example.com/media/photo-1.jpg",
    });
    const manifest = store._serialize();
    expect(manifest.assets[0]!.fileName).toBe("custom.jpg");
    expect(manifest.assets[0]!.fileStem).toBe("custom");
  });

  it("preserves user-defined index values on serialized assets", () => {
    const store = createMediaStore();
    const gallery = store.defineIndex("gallery");
    const tags = store.defineIndex("tags", { cardinality: "multi" });
    store.add("photo-1", {
      version: "v1",
      mimeType: "image/jpeg",
      url: "https://cdn.example.com/photo-1.jpg",
      indexes: [gallery("nature"), tags(["forest", "ambient"])],
    });

    const manifest = store._serialize();
    const asset = manifest.assets[0]!;
    expect(asset.indexes.gallery).toBe("nature");
    expect(asset.indexes.tags).toEqual(["forest", "ambient"]);
  });

  it("preserves metadata on serialized assets", () => {
    const store = createMediaStore();
    store.add("photo-1", {
      version: "v1",
      mimeType: "image/jpeg",
      url: "https://cdn.example.com/photo-1.jpg",
      metadata: { title: "Forest", year: 2024, nested: { ok: true } },
    });

    const manifest = store._serialize();
    expect(manifest.assets[0]!.metadata).toEqual({
      title: "Forest",
      year: 2024,
      nested: { ok: true },
    });
  });

  it("throws when a required index is missing from an asset", () => {
    const store = createMediaStore();
    store.defineIndex("category", { required: true });
    store.add("photo-1", {
      version: "v1",
      mimeType: "image/jpeg",
      url: "https://cdn.example.com/photo-1.jpg",
    });

    expect(() => store._serialize()).toThrow(StoreValidationError);
    expect(() => store._serialize()).toThrow(/required index "category" is missing/);
  });

  it("succeeds when required index is present on all assets", () => {
    const store = createMediaStore();
    const category = store.defineIndex("category", { required: true });
    store.add("photo-1", {
      version: "v1",
      mimeType: "image/jpeg",
      url: "https://cdn.example.com/photo-1.jpg",
      indexes: [category("landscape")],
    });

    expect(() => store._serialize()).not.toThrow();
  });

  it("serializes multiple assets in insertion order", () => {
    const store = createMediaStore();
    store.add("b", {
      version: "v1",
      mimeType: "image/png",
      url: "https://cdn.example.com/b.png",
    });
    store.add("a", {
      version: "v1",
      mimeType: "image/png",
      url: "https://cdn.example.com/a.png",
    });

    const manifest = store._serialize();
    expect(manifest.assets.map((a) => a.displayKey)).toEqual(["b", "a"]);
  });

  it("includes byteLength when provided", () => {
    const store = createMediaStore();
    store.add("photo-1", {
      version: "v1",
      mimeType: "image/jpeg",
      byteLength: 4096,
      url: "https://cdn.example.com/photo-1.jpg",
    });

    const manifest = store._serialize();
    expect(manifest.assets[0]!.byteLength).toBe(4096);
  });

  it("leaves byteLength undefined when omitted", () => {
    const store = createMediaStore();
    store.add("photo-1", {
      version: "v1",
      mimeType: "image/jpeg",
      url: "https://cdn.example.com/photo-1.jpg",
    });

    const manifest = store._serialize();
    expect(manifest.assets[0]!.byteLength).toBeUndefined();
  });
});

describe("MediaIndex", () => {
  it("produces IndexTag instances when called", () => {
    const store = createMediaStore();
    const gallery = store.defineIndex("gallery");
    const tag = gallery("nature");
    expect(tag).toBeInstanceOf(IndexTag);
    expect(tag.name).toBe("gallery");
    expect(tag.value).toBe("nature");
  });

  it("produces IndexTag with array values for multi-cardinality", () => {
    const store = createMediaStore();
    const tags = store.defineIndex("tags", { cardinality: "multi" });
    const tag = tags(["forest", "ambient"]);
    expect(tag).toBeInstanceOf(IndexTag);
    expect(tag.name).toBe("tags");
    expect(tag.value).toEqual(["forest", "ambient"]);
  });

  it("exposes indexName, cardinality, and required properties", () => {
    const store = createMediaStore();
    const single = store.defineIndex("a");
    expect(single.indexName).toBe("a");
    expect(single.cardinality).toBe("single");
    expect(single.required).toBe(false);

    const multi = store.defineIndex("b", { cardinality: "multi", required: true });
    expect(multi.indexName).toBe("b");
    expect(multi.cardinality).toBe("multi");
    expect(multi.required).toBe(true);
  });
});
