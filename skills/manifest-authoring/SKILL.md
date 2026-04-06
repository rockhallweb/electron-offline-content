---
name: manifest-authoring
description: >
  Writing resolveManifest functions against any remote source (CMS, S3,
  REST API). Using defineManifest, defineItem, defineAsset producer helpers
  for flat readable configs. namespacesFromEntries, itemsFromEntries,
  assetsFromEntries for array-shaped API data. Dot-delimited namespace
  hierarchies. Validation rules, version-driven cache busting.
type: core
library: electron-offline-content
library_version: "0.3.0"
requires:
  - getting-started
sources:
  - "rockhallweb/electron-offline-content:src/main/producer.ts"
  - "rockhallweb/electron-offline-content:src/shared/normalize.ts"
  - "rockhallweb/electron-offline-content:src/shared/types.ts"
  - "rockhallweb/electron-offline-content:src/internal/validation.ts"
  - "rockhallweb/electron-offline-content:src/internal/asset-file-name.ts"
---

> **Dependency:** This skill builds on getting-started. Read it first for full main → preload → renderer wiring.

## Setup

A complete `resolveManifest` function that fetches from an API and builds a manifest using composition plus `itemsFromEntries` for dynamic lists:

```typescript
import {
  defineAsset,
  defineItem,
  defineManifest,
  itemsFromEntries,
} from "@rockhallweb/electron-offline-content/main";

interface ApiCourse {
  id: string;
  title: string;
  revision: string;
  level: "beginner" | "advanced";
  videoUrl: string;
  posterUrl: string;
  subtitleUrl: string | null;
}

async function resolveManifest(): Promise<ReturnType<typeof defineManifest>> {
  const res = await fetch("https://cms.example.com/api/courses");
  const courses: ApiCourse[] = await res.json();

  const beginnerCourses = courses.filter((c) => c.level === "beginner");
  const advancedCourses = courses.filter((c) => c.level === "advanced");

  return defineManifest({
    snapshotId: `courses-${Date.now()}`,
    namespaces: {
      "courses.beginner": {
        label: "Beginner Courses",
        items: itemsFromEntries(beginnerCourses, (course) => [
          course.id,
          courseToItem(course),
        ]),
      },
      "courses.advanced": {
        label: "Advanced Courses",
        items: itemsFromEntries(advancedCourses, (course) => [
          course.id,
          courseToItem(course),
        ]),
      },
    },
  });
}

function courseToItem(course: ApiCourse) {
  const assets: Record<string, ReturnType<typeof defineAsset>> = {
    video: defineAsset({
      role: "primary",
      kind: "video",
      mimeType: "video/mp4",
      source: { url: course.videoUrl },
    }),
    poster: defineAsset({
      role: "poster",
      kind: "poster",
      source: { url: course.posterUrl },
    }),
  };

  if (course.subtitleUrl) {
    assets["subs-en"] = defineAsset({
      role: "subtitle",
      kind: "subtitle",
      fileName: "en.vtt",
      source: { url: course.subtitleUrl },
    });
  }

  return defineItem({
    version: course.revision,
    kind: "video",
    title: course.title,
    assets,
  });
}
```

## Core Patterns

### Dot-delimited namespace hierarchies

Use dot notation in **namespace map keys** (they are flat strings, not nested objects). `useMedia({ kind: "list", namespace: "courses", recursive: true })` queries all descendant namespaces.

```typescript
import { defineManifest } from "@rockhallweb/electron-offline-content/main";

defineManifest({
  namespaces: {
    courses: { label: "All Courses", items: {} },
    "courses.beginner": { label: "Beginner", items: beginnerItemsRecord },
    "courses.beginner.featured": { label: "Featured Beginner", items: featuredItemsRecord },
    "courses.advanced": { label: "Advanced", items: advancedItemsRecord },
  },
});
```

```typescript
// In renderer — queries courses.beginner, courses.beginner.featured, courses.advanced
const allCourses = useMedia({ kind: "list", namespace: "courses", recursive: true });
const beginnerOnly = useMedia({ kind: "list", namespace: "courses.beginner" });
```

### Record keys vs redundant ids

`resolveManifest` must return a **`MediaCacheManifest`**: `namespaces` is `Record<string, MediaNamespaceValue>`, each `items` is `Record<string, MediaItemValue>`, each `assets` is `Record<string, MediaAssetValue>`. The map key **is** the namespace id, item id, or asset id — do not repeat `id` / `key` on the value objects.

### Building records from arrays

Use **`namespacesFromEntries`**, **`itemsFromEntries`**, and **`assetsFromEntries`** when the source is array-shaped. Each helper:

- maps each element to `[key, value]`
- validates values with Zod
- throws **`ManifestValidationError`** on duplicate keys (with first and duplicate indices)

### Version-driven cache busting

When an item's `version` changes, all its assets are re-downloaded. Items with unchanged versions keep their cached blobs.

```typescript
import { defineItem } from "@rockhallweb/electron-offline-content/main";

defineItem({
  version: apiEntry.updatedAt, // timestamp-based: "2026-03-15T08:30:00Z"
  kind: "video",
  assets,
});

defineItem({
  version: apiEntry.contentMd5, // content-hash: "a1b2c3d4e5f6"
  kind: "image",
  assets,
});
```

### Multi-asset items

An item can have multiple assets with different roles. Use `assetsByRole` in the renderer for role-based lookup.

```typescript
import { defineAsset, defineItem } from "@rockhallweb/electron-offline-content/main";

const inducteeItem = defineItem({
  version: "3",
  kind: "video",
  title: "Beyoncé Induction Ceremony",
  assets: {
    "main-video": defineAsset({
      role: "primary",
      kind: "video",
      mimeType: "video/mp4",
      source: { url: "https://cdn.example.com/beyonce-ceremony.mp4" },
    }),
    poster: defineAsset({
      role: "poster",
      kind: "poster",
      source: { url: "https://cdn.example.com/beyonce-poster.jpg" },
    }),
    "subs-en": defineAsset({
      role: "subtitle",
      kind: "subtitle",
      fileName: "en.vtt",
      source: { url: "https://cdn.example.com/beyonce-en.vtt" },
    }),
    "subs-es": defineAsset({
      role: "subtitle-es",
      kind: "subtitle",
      fileName: "es.vtt",
      source: { url: "https://cdn.example.com/beyonce-es.vtt" },
    }),
  },
});
```

```tsx
// In renderer
const item = useMedia({ kind: "item", namespace: "inductees", id: "inductee-2026-beyonce" });
if (!item.loading && item.data) {
  const video = item.data.assetsByRole["primary"];
  const poster = item.data.assetsByRole["poster"];
  const subtitleEn = item.data.assetsByRole["subtitle"];
  const subtitleEs = item.data.assetsByRole["subtitle-es"];

  return (
    <video src={video?.url} poster={poster?.url}>
      {subtitleEn && <track src={subtitleEn.url} srcLang="en" label="English" default />}
      {subtitleEs && <track src={subtitleEs.url} srcLang="es" label="Español" />}
    </video>
  );
}
```

## Common Mistakes

### HIGH: Duplicate keys when building from arrays

Object literals cannot express duplicate keys. For dynamic lists, **`itemsFromEntries`** / **`namespacesFromEntries`** throw **`ManifestValidationError`** with the colliding key and indices.

### HIGH: Omitting required item version field

`version` is required (min length 1) and drives cache busting. Fails Zod validation at manifest build time.

```typescript
// WRONG — missing version
defineItem({
  kind: "video",
  assets,
});
```

```typescript
// CORRECT — version present
defineItem({
  version: "2026-03-15",
  kind: "video",
  assets,
});
```

Source: validation.ts

### HIGH: Asset URL without filename in path

When `fileName` is omitted, it is derived from the URL basename. URLs ending in `/` or with no parseable filename fail derivation.

```typescript
// WRONG — URL has no filename to derive
defineAsset({
  role: "primary",
  kind: "video",
  source: { url: "https://cdn.example.com/api/stream/" },
});
```

```typescript
// CORRECT — explicit fileName when URL lacks one
defineAsset({
  role: "primary",
  kind: "video",
  fileName: "ceremony.mp4",
  source: { url: "https://cdn.example.com/api/stream/" },
});
```

Source: internal/asset-file-name.ts

### HIGH: Deep nesting instead of using producer helpers

Inlining deeply nested objects into a single `defineManifest` call obscures validation errors. The helpers validate each piece individually with clearer messages.

```typescript
// CORRECT — flat composition
const mainAsset = defineAsset({
  role: "primary",
  kind: "video",
  source: { url: "https://cdn.example.com/intro.mp4" },
});

const introItem = defineItem({
  version: "1",
  kind: "video",
  assets: { main: mainAsset },
});

const manifest = defineManifest({
  namespaces: { videos: { items: { intro: introItem } } },
});
```

Source: README

### MEDIUM: Using non-HTTP asset source URLs

Zod validation enforces `http://` or `https://` schemes. `file://`, `data:`, `blob:` are rejected.

### MEDIUM: Duplicate item IDs within a namespace

Use **`itemsFromEntries`** with a stable unique key per row (e.g. `entry.slug`), or ensure object keys are unique when authoring literals.

### MEDIUM: Over-namespacing with too many granular namespaces

Prefer one namespace with multiple items over many namespaces with one item each when items belong to the same app section.

### HIGH Tension: Strict validation vs sync-time failures

Use **`defineManifest`** / **`defineItem`** / **`defineAsset`** at build time so errors surface when you construct the manifest, not only at sync.

See also: getting-started/SKILL.md § Common Mistakes

### HIGH Tension: Manifest-time auth vs download-time auth

Pre-signed URLs at manifest build time need a TTL that covers the full download queue. For large catalogs, prefer **`resolveAssetRequest`**.

See also: authenticated-downloads/SKILL.md § Common Mistakes

## Cross-References

See also: getting-started/SKILL.md — Full main → preload → renderer wiring
See also: react-rendering/SKILL.md — Namespace organization determines how hooks query content
See also: authenticated-downloads/SKILL.md — Auth strategies for asset sources
