import { describe, expect, it } from "vitest";
import { hashKey } from "../../src/internal/asset-key.js";
import { mediaKindFromMime } from "../../src/internal/media-kind.js";
import { createMediaStore } from "../../src/main/store.js";
import { StoreValidationError } from "../../src/shared/errors.js";
import { BUILTIN_INDEX_NAMES, normalizeManifest } from "../../src/shared/normalize.js";
import { normalizeStem } from "../../src/shared/stem.js";

describe("normalizeManifest", () => {
  describe("expiration validation", () => {
    it("preserves a valid expiresAt timestamp with Z suffix", () => {
      const store = createMediaStore({ expiresAt: "2026-04-06T12:30:00.000Z" });
      const manifest = normalizeManifest(store._serialize());
      expect(manifest.expiresAt).toBe("2026-04-06T12:30:00.000Z");
    });

    it("preserves a valid expiresAt timestamp with explicit offset", () => {
      const store = createMediaStore({ expiresAt: "2026-04-06T12:30:00-05:00" });
      const manifest = normalizeManifest(store._serialize());
      expect(manifest.expiresAt).toBe("2026-04-06T12:30:00-05:00");
    });

    it("allows expiresAt to be omitted", () => {
      const store = createMediaStore();
      const manifest = normalizeManifest(store._serialize());
      expect(manifest.expiresAt).toBeUndefined();
    });

    it("rejects an expiresAt timestamp without a timezone offset", () => {
      const store = createMediaStore({ expiresAt: "2026-04-06T12:30:00" });
      expect(() => normalizeManifest(store._serialize())).toThrow(StoreValidationError);
      expect(() => normalizeManifest(store._serialize())).toThrow(
        /ISO 8601 timestamp with a timezone offset or Z suffix/,
      );
    });

    it("rejects a non-ISO expiresAt timestamp", () => {
      const store = createMediaStore({ expiresAt: "2026-04-06 12:30:00" });
      expect(() => normalizeManifest(store._serialize())).toThrow(StoreValidationError);
    });

    it("rejects a well-formed expiresAt that does not parse as a date", () => {
      const store = createMediaStore({ expiresAt: "2026-99-99T12:30:00Z" });
      expect(() => normalizeManifest(store._serialize())).toThrow(StoreValidationError);
    });
  });

  describe("built-in index injection", () => {
    it("appends built-in index definitions after user-defined indexes", () => {
      const store = createMediaStore();
      store.defineIndex("gallery");
      store.defineIndex("tags", { cardinality: "multi", required: true });
      const manifest = normalizeManifest(store._serialize());
      const names = manifest.indexDefinitions.map((d) => d.name);
      expect(names).toEqual(["gallery", "tags", "mimeType", "mediaKind"]);
    });

    it("produces only built-in index definitions for an empty store", () => {
      const store = createMediaStore({ snapshotId: "empty" });
      const manifest = normalizeManifest(store._serialize());
      expect(manifest.snapshotId).toBe("empty");
      expect(manifest.assets).toEqual([]);
      expect(manifest.indexDefinitions).toEqual([
        { name: "mimeType", cardinality: "single", required: false, builtin: true },
        { name: "mediaKind", cardinality: "single", required: false, builtin: true },
      ]);
    });

    it("exposes built-in index names matching the injected definitions", () => {
      expect([...BUILTIN_INDEX_NAMES]).toEqual(["mimeType", "mediaKind"]);
    });

    it("auto-populates mimeType and mediaKind indexes on each asset", () => {
      const store = createMediaStore();
      store.add("video-1", {
        version: "v1",
        mimeType: "video/mp4",
        url: "https://cdn.example.com/clip.mp4",
      });
      const manifest = normalizeManifest(store._serialize());
      const asset = manifest.assets[0]!;
      expect(asset.indexes.mimeType).toBe("video/mp4");
      expect(asset.indexes.mediaKind).toBe("video");
      expect(asset.mediaKind).toBe("video");
    });

    it("preserves user-defined index values alongside built-in indexes", () => {
      const store = createMediaStore();
      const gallery = store.defineIndex("gallery");
      const tags = store.defineIndex("tags", { cardinality: "multi" });
      store.add("photo-1", {
        version: "v1",
        mimeType: "image/jpeg",
        url: "https://cdn.example.com/photo-1.jpg",
        indexes: [gallery("nature"), tags(["forest", "ambient"])],
      });

      const manifest = normalizeManifest(store._serialize());
      const asset = manifest.assets[0]!;
      expect(asset.indexes).toEqual({
        gallery: "nature",
        tags: ["forest", "ambient"],
        mimeType: "image/jpeg",
        mediaKind: "image",
      });
    });
  });

  describe("media kind derivation", () => {
    it("derives mediaKind correctly for various MIME types", () => {
      const store = createMediaStore();

      const cases: Array<[string, string, string]> = [
        ["vid", "video/mp4", "video"],
        ["img", "image/png", "image"],
        ["aud", "audio/mpeg", "audio"],
        ["doc", "application/pdf", "document"],
        ["html", "text/html", "html"],
        ["txt", "text/plain", "text"],
        ["json", "application/json", "text"],
        ["bin", "application/octet-stream", "binary"],
      ];

      for (const [key, mime, expectedKind] of cases) {
        expect(mediaKindFromMime(mime)).toBe(expectedKind);
        store.add(key, {
          version: "v1",
          mimeType: mime,
          url: `https://cdn.example.com/${key}.bin`,
        });
      }

      const manifest = normalizeManifest(store._serialize());
      for (const [key, , expectedKind] of cases) {
        const asset = manifest.assets.find((a) => a.displayKey === key);
        expect(asset?.key).toBe(hashKey(key));
        expect(asset?.mediaKind).toBe(expectedKind);
        expect(asset?.indexes.mediaKind).toBe(expectedKind);
      }
    });
  });

  describe("file stem normalization", () => {
    it("derives fileStem from the derived fileName", () => {
      const store = createMediaStore();
      store.add("photo-1", {
        version: "v1",
        mimeType: "image/jpeg",
        url: "https://cdn.example.com/media/photo-1.jpg",
      });
      const manifest = normalizeManifest(store._serialize());
      expect(manifest.assets[0]!.fileName).toBe("photo-1.jpg");
      expect(manifest.assets[0]!.fileStem).toBe("photo-1");
    });

    it("derives fileStem from an explicit fileName", () => {
      const store = createMediaStore();
      store.add("photo-1", {
        version: "v1",
        mimeType: "image/jpeg",
        fileName: "custom.jpg",
        url: "https://cdn.example.com/media/photo-1.jpg",
      });
      const manifest = normalizeManifest(store._serialize());
      expect(manifest.assets[0]!.fileStem).toBe("custom");
    });

    it("applies the read-side stem rule on the write side", () => {
      const store = createMediaStore();
      store.add("photo-1", {
        version: "v1",
        mimeType: "image/jpeg",
        fileName: "Mixed-Case Stem.JPG",
        url: "https://cdn.example.com/media/photo-1.jpg",
      });
      const manifest = normalizeManifest(store._serialize());
      const stem = manifest.assets[0]!.fileStem;
      expect(stem).toBe("mixed-case stem");
      expect(stem).toBe(normalizeStem("Mixed-Case Stem"));
    });

    it("keeps dotfile names whole when there is no extension to strip", () => {
      const store = createMediaStore();
      store.add("config", {
        version: "v1",
        mimeType: "text/plain",
        fileName: ".gitignore",
        url: "https://cdn.example.com/config",
      });
      const manifest = normalizeManifest(store._serialize());
      expect(manifest.assets[0]!.fileStem).toBe(".gitignore");
    });
  });

  describe("manifest shape", () => {
    it("passes authored asset fields through unchanged", () => {
      const store = createMediaStore({
        snapshotId: "snap-1",
        retrievedAt: "2025-06-01T00:00:00Z",
      });
      store.add(["nature", "forest", "main"], {
        version: "v7",
        mimeType: "video/mp4",
        byteLength: 4096,
        url: "https://cdn.example.com/forest.mp4",
        metadata: { title: "Forest", nested: { ok: true } },
      });

      const manifest = normalizeManifest(store._serialize());
      expect(manifest.snapshotId).toBe("snap-1");
      expect(manifest.retrievedAt).toBe("2025-06-01T00:00:00Z");
      const asset = manifest.assets[0]!;
      expect(asset.key).toBe(hashKey(["nature", "forest", "main"]));
      expect(asset.displayKey).toBe("nature/forest/main");
      expect(asset.version).toBe("v7");
      expect(asset.mimeType).toBe("video/mp4");
      expect(asset.byteLength).toBe(4096);
      expect(asset.url).toBe("https://cdn.example.com/forest.mp4");
      expect(asset.metadata).toEqual({ title: "Forest", nested: { ok: true } });
    });

    it("does not mutate the authored manifest", () => {
      const store = createMediaStore();
      store.add("photo-1", {
        version: "v1",
        mimeType: "image/jpeg",
        url: "https://cdn.example.com/photo-1.jpg",
      });

      const authored = store._serialize();
      normalizeManifest(authored);
      expect(authored.indexDefinitions).toEqual([]);
      expect(authored.assets[0]!.indexes).toEqual({});
      expect("mediaKind" in authored.assets[0]!).toBe(false);
      expect("fileStem" in authored.assets[0]!).toBe(false);
    });
  });
});
