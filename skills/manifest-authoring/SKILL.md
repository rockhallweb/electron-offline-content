---
name: store-authoring
description: >
  Writing resolveStore functions against any remote source (CMS, S3,
  REST API). Using createMediaStore, store.defineIndex, and store.add
  for flat asset stores. User-defined secondary indexes for querying.
  Per-asset versioning, asset key conventions, validation rules,
  version-driven cache busting. Embedding signed URLs and auth
  headers in source during resolveStore.
type: core
library: electron-offline-content
library_version: "0.4.0"
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
import { createMediaStore, mediaKindFromMime } from "@rockhallweb/electron-offline-content/main";

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
  store.defineIndex("level", (asset) => asset.metadata.level as string);
  store.defineIndex("type", (asset) => asset.metadata.type as string);

  for (const course of courses) {
    store.add({
      key: `course/${course.id}/video`,
      version: course.revision,
      kind: "video",
      mimeType: "video/mp4",
      source: { url: course.videoUrl },
      metadata: { title: course.title, level: course.level, type: "video" },
    });

    store.add({
      key: `course/${course.id}/poster`,
      version: course.revision,
      kind: "image",
      mimeType: "image/jpeg",
      source: { url: course.posterUrl },
      metadata: { title: `${course.title} poster`, level: course.level, type: "poster" },
    });

    if (course.subtitleUrl) {
      store.add({
        key: `course/${course.id}/subs-en`,
        version: course.revision,
        kind: "document",
        mimeType: "text/vtt",
        fileName: "en.vtt",
        source: { url: course.subtitleUrl },
        metadata: { title: `${course.title} subtitles`, level: course.level, type: "subtitle" },
      });
    }
  }

  return store;
}
```

## Core Patterns

### User-defined secondary indexes

Indexes replace the old namespace hierarchy. Define them with `store.defineIndex()` before adding assets. Each index extracts a string value from the asset for querying with `useMediaByIndex` in the renderer or `listByIndex` in the main process.

```typescript
import { createMediaStore } from "@rockhallweb/electron-offline-content/main";

const store = createMediaStore();

store.defineIndex("category", (asset) => asset.metadata.category as string);
store.defineIndex("year", (asset) => String(asset.metadata.year));
store.defineIndex("floor", (asset) => asset.metadata.floor as string);

for (const exhibit of exhibits) {
  store.add({
    key: `exhibit/${exhibit.slug}`,
    version: exhibit.revision,
    kind: mediaKindFromMime(exhibit.mimeType),
    mimeType: exhibit.mimeType,
    source: { url: exhibit.mediaUrl },
    metadata: {
      title: exhibit.title,
      category: exhibit.category,
      year: exhibit.year,
      floor: exhibit.floor,
    },
  });
}
```

```tsx
// In renderer — query by index
const floor2 = useMediaByIndex("floor", "2", { limit: 100 });
const videos2026 = useMediaByIndex("year", "2026");
```

### Asset key conventions

Asset keys are flat strings that uniquely identify each asset. Use forward-slash delimited paths for logical grouping:

```typescript
store.add({ key: "video/welcome", ... });
store.add({ key: "video/welcome/poster", ... });
store.add({ key: "inductee/2026/beyonce/ceremony", ... });
store.add({ key: "inductee/2026/beyonce/poster", ... });
```

Keys are used directly in `useMediaAsset(key)` for single-asset lookups and in the `media://asset/{encodedAssetKey}` protocol URL.

### Per-asset versioning

Each asset has its own `version` string. When the version changes, the asset is re-downloaded. Assets with unchanged versions keep their cached blobs.

```typescript
store.add({
  key: "video/welcome",
  version: apiEntry.updatedAt, // timestamp-based: "2026-03-15T08:30:00Z"
  kind: "video",
  mimeType: "video/mp4",
  source: { url: apiEntry.videoUrl },
});

store.add({
  key: "image/logo",
  version: apiEntry.contentMd5, // content-hash: "a1b2c3d4e5f6"
  kind: "image",
  mimeType: "image/png",
  source: { url: apiEntry.logoUrl },
});
```

### Embedding auth in resolveStore

Since `resolveAssetRequest` has been removed, embed signed URLs or auth headers directly in `source` during `resolveStore()`:

```typescript
import { createMediaStore } from "@rockhallweb/electron-offline-content/main";
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

    store.add({
      key: item.id,
      version: item.revision,
      kind: "video",
      mimeType: "video/mp4",
      source: { url: signedUrl },
    });
  }

  return store;
}
```

For long-lived API keys, use `source.headers` instead:

```typescript
store.add({
  key: "video/welcome",
  version: "v2",
  kind: "video",
  mimeType: "video/mp4",
  source: {
    url: "https://cdn.example.com/video.mp4",
    headers: { Authorization: `Bearer ${API_KEY}` },
  },
});
```

### Multi-asset content

Related assets share a key prefix and use the same indexes. Use `useMediaAsset(key)` for individual lookups or `useMediaByIndex` to query by a shared index value:

```typescript
const store = createMediaStore();
store.defineIndex("inductee", (asset) => asset.metadata.inducteeId as string);
store.defineIndex("role", (asset) => asset.metadata.role as string);

store.add({
  key: "inductee/2026/beyonce/ceremony",
  version: "3",
  kind: "video",
  mimeType: "video/mp4",
  source: { url: "https://cdn.example.com/beyonce-ceremony.mp4" },
  metadata: { inducteeId: "beyonce-2026", role: "primary", title: "Beyoncé Induction Ceremony" },
});

store.add({
  key: "inductee/2026/beyonce/poster",
  version: "3",
  kind: "image",
  mimeType: "image/jpeg",
  source: { url: "https://cdn.example.com/beyonce-poster.jpg" },
  metadata: { inducteeId: "beyonce-2026", role: "poster", title: "Beyoncé Poster" },
});

store.add({
  key: "inductee/2026/beyonce/subs-en",
  version: "3",
  kind: "document",
  mimeType: "text/vtt",
  fileName: "en.vtt",
  source: { url: "https://cdn.example.com/beyonce-en.vtt" },
  metadata: { inducteeId: "beyonce-2026", role: "subtitle", title: "English subtitles" },
});
```

```tsx
// In renderer — look up related assets by index
const beyonceAssets = useMediaByIndex("inductee", "beyonce-2026");
// Or look up individual assets by key
const ceremony = useMediaAsset("inductee/2026/beyonce/ceremony");
const poster = useMediaAsset("inductee/2026/beyonce/poster");
```

## Common Mistakes

### HIGH: Duplicate asset keys in store.add calls

`store.add()` throws `StoreValidationError` when a key has already been added to the store. Each asset key must be unique.

```typescript
// WRONG — duplicate key
store.add({ key: "video/welcome", version: "1", kind: "video", ... });
store.add({ key: "video/welcome", version: "2", kind: "video", ... });
```

```typescript
// CORRECT — unique keys
store.add({ key: "video/welcome", version: "1", kind: "video", ... });
store.add({ key: "video/welcome-v2", version: "2", kind: "video", ... });
```

Source: store.ts; validation.ts

### HIGH: Omitting required asset version field

`version` is required (min length 1) and drives cache busting. Fails validation at `store.add()` time.

```typescript
// WRONG — missing version
store.add({
  key: "video/welcome",
  kind: "video",
  source: { url },
});
```

```typescript
// CORRECT — version present
store.add({
  key: "video/welcome",
  version: "2026-03-15",
  kind: "video",
  source: { url },
});
```

Source: validation.ts

### HIGH: Asset URL without filename in path

When `fileName` is omitted, it is derived from the URL basename. URLs ending in `/` or with no parseable filename fail derivation.

```typescript
// WRONG — URL has no filename to derive
store.add({
  key: "video/ceremony",
  version: "1",
  kind: "video",
  source: { url: "https://cdn.example.com/api/stream/" },
});
```

```typescript
// CORRECT — explicit fileName when URL lacks one
store.add({
  key: "video/ceremony",
  version: "1",
  kind: "video",
  fileName: "ceremony.mp4",
  source: { url: "https://cdn.example.com/api/stream/" },
});
```

Source: internal/asset-file-name.ts

### HIGH: Forgetting to defineIndex before querying

Indexes must be defined with `store.defineIndex()` before assets are added. If you query an undefined index with `useMediaByIndex` or `listByIndex`, the query returns no results.

```typescript
// WRONG — index not defined
const store = createMediaStore();
store.add({ key: "video/welcome", ..., metadata: { category: "lobby" } });
// useMediaByIndex("category", "lobby") returns nothing
```

```typescript
// CORRECT — define index before adding assets
const store = createMediaStore();
store.defineIndex("category", (asset) => asset.metadata.category as string);
store.add({ key: "video/welcome", ..., metadata: { category: "lobby" } });
```

Source: store.ts; README

### MEDIUM: Using non-HTTP asset source URLs

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
See also: react-rendering/SKILL.md — Index definitions determine how hooks query content
See also: authenticated-downloads/SKILL.md — Auth strategies for asset sources
