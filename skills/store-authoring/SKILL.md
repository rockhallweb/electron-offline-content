---
name: store-authoring
description: >
  Writing resolveStore functions against any remote source (CMS, S3,
  REST API). Using createMediaStore, store.defineIndex, and store.add
  for flat asset stores. User-defined secondary indexes for querying.
  Per-asset versioning, asset key conventions, validation rules,
  version-driven cache busting. Embedding presigned URLs in asset
  url fields during resolveStore.
type: core
library: electron-offline-content
library_version: "0.4.1"
requires:
  - getting-started
sources:
  - "rockhallweb/electron-offline-content:src/main/store.ts"
  - "rockhallweb/electron-offline-content:src/shared/normalize.ts"
  - "rockhallweb/electron-offline-content:src/shared/types.ts"
  - "rockhallweb/electron-offline-content:src/internal/validation.ts"
  - "rockhallweb/electron-offline-content:src/internal/asset-file-name.ts"
---

> **Dependency:** This skill builds on getting-started. Read it first for full main → preload → renderer wiring.

## Setup

A complete `resolveStore` function that fetches from an API and builds a flat asset store with secondary indexes:

```typescript
import { createMediaStore } from "@rockhall/electron-offline-content/main";

interface ApiCourse {
  id: string;
  title: string;
  revision: string;
  level: "beginner" | "advanced";
  videoUrl: string;
  posterUrl: string;
  subtitleUrl: string | null;
}

async function resolveStore() {
  const res = await fetch("https://cms.example.com/api/courses");
  const courses: ApiCourse[] = await res.json();

  const store = createMediaStore();
  const level = store.defineIndex("level");
  const type = store.defineIndex("type");

  for (const course of courses) {
    store.add(["course", course.id, "video"], {
      version: course.revision,
      mimeType: "video/mp4",
      url: course.videoUrl,
      metadata: { title: course.title, level: course.level, type: "video" },
      indexes: [level(course.level), type("video")],
    });

    store.add(["course", course.id, "poster"], {
      version: course.revision,
      mimeType: "image/jpeg",
      url: course.posterUrl,
      metadata: { title: `${course.title} poster`, level: course.level, type: "poster" },
      indexes: [level(course.level), type("poster")],
    });

    if (course.subtitleUrl) {
      store.add(["course", course.id, "subs-en"], {
        version: course.revision,
        mimeType: "text/vtt",
        fileName: "en.vtt",
        url: course.subtitleUrl,
        metadata: { title: `${course.title} subtitles`, level: course.level, type: "subtitle" },
        indexes: [level(course.level), type("subtitle")],
      });
    }
  }

  return store;
}
```

Resolved assets expose `asset.key` (storage hash) and `asset.displayKey` (human-readable path, e.g. `course/intro-101/video`).

## Core Patterns

### User-defined secondary indexes

Indexes replace the old namespace hierarchy. Define them with `store.defineIndex()` before adding assets, then pass `IndexTag` values from each handle into `store.add()` for querying with `renderer.bridge.listByIndex()` in the renderer or `listByIndex` in the main process.

```typescript
import { createMediaStore } from "@rockhall/electron-offline-content/main";

const store = createMediaStore();

const category = store.defineIndex("category");
const year = store.defineIndex("year");
const floor = store.defineIndex("floor");

for (const exhibit of exhibits) {
  store.add(["exhibit", exhibit.slug], {
    version: exhibit.revision,
    mimeType: exhibit.mimeType,
    url: exhibit.mediaUrl,
    metadata: {
      title: exhibit.title,
      category: exhibit.category,
      year: exhibit.year,
      floor: exhibit.floor,
    },
    indexes: [category(exhibit.category), year(String(exhibit.year)), floor(exhibit.floor)],
  });
}
```

```typescript
// In renderer — query by index
const floor2 = await renderer.bridge.listByIndex("floor", "2", { limit: 100 });
const videos2026 = await renderer.bridge.listByIndex("year", "2026");
```

### Asset key conventions

The first argument to `store.add()` is an `AssetKeyInput`: a non-empty string or a non-empty array of non-empty string segments. Arrays avoid ambiguity at segment boundaries and produce a readable `displayKey` (segments joined with `/`) while `key` on resolved assets remains the storage hash.

```typescript
store.add(["video", "welcome"], { ... });
store.add(["video", "welcome", "poster"], { ... });
store.add(["inductee", "2026", "beyonce", "ceremony"], { ... });
store.add(["inductee", "2026", "beyonce", "poster"], { ... });
```

Use the same `AssetKeyInput` in `renderer.bridge.getAsset(key)` for single-asset lookups. Protocol URLs still use the encoded storage identity derived from the hash.

### Per-asset versioning

Each asset has its own `version` string. When the version changes, the asset is re-downloaded. Assets with unchanged versions keep their cached blobs.

```typescript
store.add(["video", "welcome"], {
  version: apiEntry.updatedAt, // timestamp-based: "2026-03-15T08:30:00Z"
  mimeType: "video/mp4",
  url: apiEntry.videoUrl,
});

store.add(["image", "logo"], {
  version: apiEntry.contentMd5, // content-hash: "a1b2c3d4e5f6"
  mimeType: "image/png",
  url: apiEntry.logoUrl,
});
```

### Embedding auth in resolveStore

Since `resolveAssetRequest` has been removed, embed presigned (or otherwise auth-bearing) URLs in each asset’s `url` field during `resolveStore()`:

```typescript
import { createMediaStore } from "@rockhall/electron-offline-content/main";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "us-east-1" });

async function resolveStore() {
  const store = createMediaStore();
  const catalog = await fetchCatalog();

  for (const item of catalog) {
    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: "my-content-bucket", Key: item.objectKey }),
      { expiresIn: 3600 },
    );

    store.add(["s3", item.id], {
      version: item.revision,
      mimeType: "video/mp4",
      url: signedUrl,
    });
  }

  return store;
}
```

### Multi-asset content

Related assets share a key prefix and use the same indexes. Use `renderer.bridge.getAsset(key)` for individual lookups or `renderer.bridge.listByIndex()` to query by a shared index value:

```typescript
const store = createMediaStore();
const inductee = store.defineIndex("inductee");
const role = store.defineIndex("role");

store.add(["inductee", "2026", "beyonce", "ceremony"], {
  version: "3",
  mimeType: "video/mp4",
  url: "https://cdn.example.com/beyonce-ceremony.mp4",
  metadata: { inducteeId: "beyonce-2026", role: "primary", title: "Beyoncé Induction Ceremony" },
  indexes: [inductee("beyonce-2026"), role("primary")],
});

store.add(["inductee", "2026", "beyonce", "poster"], {
  version: "3",
  mimeType: "image/jpeg",
  url: "https://cdn.example.com/beyonce-poster.jpg",
  metadata: { inducteeId: "beyonce-2026", role: "poster", title: "Beyoncé Poster" },
  indexes: [inductee("beyonce-2026"), role("poster")],
});

store.add(["inductee", "2026", "beyonce", "subs-en"], {
  version: "3",
  mimeType: "text/vtt",
  fileName: "en.vtt",
  url: "https://cdn.example.com/beyonce-en.vtt",
  metadata: { inducteeId: "beyonce-2026", role: "subtitle", title: "English subtitles" },
  indexes: [inductee("beyonce-2026"), role("subtitle")],
});
```

```typescript
// In renderer — look up related assets by index
const beyonceAssets = await renderer.bridge.listByIndex("inductee", "beyonce-2026");
// Or look up individual assets by the same AssetKeyInput used in resolveStore
const ceremony = await renderer.bridge.getAsset(["inductee", "2026", "beyonce", "ceremony"]);
const poster = await renderer.bridge.getAsset(["inductee", "2026", "beyonce", "poster"]);
// asset.displayKey shows the joined path; asset.key is the stable hash
```

## Common Mistakes

### HIGH: Duplicate asset keys in store.add calls

`store.add()` throws `StoreValidationError` when a key has already been added to the store. Each asset key must be unique.

```typescript
// WRONG — duplicate key (same AssetKeyInput resolves to the same storage hash)
store.add(["video", "welcome"], { version: "1", mimeType: "video/mp4", url });
store.add(["video", "welcome"], { version: "2", mimeType: "video/mp4", url });
```

```typescript
// CORRECT — unique keys
store.add(["video", "welcome"], { version: "1", mimeType: "video/mp4", url });
store.add(["video", "welcome-v2"], { version: "2", mimeType: "video/mp4", url });
```

Source: store.ts; validation.ts

### HIGH: Omitting required asset version field

`version` is required (min length 1) and drives cache busting. Fails validation at `store.add()` time.

```typescript
// WRONG — missing version
store.add(["video", "welcome"], {
  mimeType: "video/mp4",
  url,
});
```

```typescript
// CORRECT — version present
store.add(["video", "welcome"], {
  version: "2026-03-15",
  mimeType: "video/mp4",
  url,
});
```

Source: validation.ts

### HIGH: Asset URL without filename in path

When `fileName` is omitted, it is derived from the URL basename. URLs ending in `/` or with no parseable filename fail derivation.

```typescript
// WRONG — URL has no filename to derive
store.add(["video", "ceremony"], {
  version: "1",
  mimeType: "video/mp4",
  url: "https://cdn.example.com/api/stream/",
});
```

```typescript
// CORRECT — explicit fileName when URL lacks one
store.add(["video", "ceremony"], {
  version: "1",
  mimeType: "video/mp4",
  fileName: "ceremony.mp4",
  url: "https://cdn.example.com/api/stream/",
});
```

Source: internal/asset-file-name.ts

### HIGH: Forgetting to defineIndex before querying

Indexes must be defined with `store.defineIndex()` before assets are added. If you query an undefined index with `renderer.bridge.listByIndex()` or `listByIndex`, the query returns no results.

```typescript
// WRONG — index not defined
const store = createMediaStore();
store.add(["video", "welcome"], {
  version: "1",
  mimeType: "video/mp4",
  url,
  metadata: { category: "lobby" },
});
// renderer.bridge.listByIndex("category", "lobby") returns nothing
```

```typescript
// CORRECT — define index before adding assets
const store = createMediaStore();
const category = store.defineIndex("category");
store.add(["video", "welcome"], {
  version: "1",
  mimeType: "video/mp4",
  url,
  metadata: { category: "lobby" },
  indexes: [category("lobby")],
});
```

Source: store.ts; README

### MEDIUM: Using non-HTTP asset URLs

Validation enforces `http://` or `https://` schemes. `file://`, `data:`, `blob:` are rejected.

### MEDIUM: Index function returning inconsistent types

Index functions must return a `string`. Returning `undefined`, `null`, or a non-string value for some assets causes those assets to be missing from index queries.

```typescript
// WRONG — returns number, not string
store.defineIndex("year", (asset) => asset.metadata.year);

// CORRECT — always return a string
store.defineIndex("year", (asset) => String(asset.metadata.year));
```

Source: store.ts

### MEDIUM: Too many fine-grained indexes

Each index adds overhead during store building and sync. Define indexes that match your actual query patterns. Prefer a single index with meaningful values over many single-purpose indexes.

Source: Maintainer interview

### HIGH Tension: Strict validation vs sync-time failures

Use **`createMediaStore`** and **`store.add()`** so errors surface when you build the store, not only during sync. Validation catches missing `version`, duplicate keys, and invalid URLs at build time.

See also: getting-started/SKILL.md § Common Mistakes

### HIGH Tension: Pre-signed URL TTL vs catalog size

Pre-signed URLs embedded in `resolveStore` need a TTL that covers the full download queue. For large catalogs (100+ assets), sign URLs with a generous TTL and set `expiresAt` on the store so the cache can fail fast with `STORE_EXPIRED` before a stale URL is fetched.

See also: authenticated-downloads/SKILL.md § Common Mistakes

## Cross-References

See also: getting-started/SKILL.md — Full main → preload → renderer wiring
See also: authenticated-downloads/SKILL.md — Auth strategies for asset sources
