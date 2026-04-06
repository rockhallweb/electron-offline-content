---
name: manifest-authoring
description: >
  Writing resolveManifest functions against any remote source (CMS, S3,
  REST API). Using defineManifest, defineManifestItem, defineManifestAsset
  producer helpers for flat readable configs. Organizing content into
  dot-delimited namespace hierarchies. Validation rules for keys,
  versions, asset URLs, and fileName derivation. Version-driven cache
  busting. ManifestInput shorthand forms (namespace array, item array).
type: core
library: electron-offline-content
library_version: "0.1.1"
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

A complete `resolveManifest` function that fetches from an API and builds a manifest using the flat composition pattern:

```typescript
import {
  defineManifest,
  defineManifestItem,
  defineManifestAsset,
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

  const beginnerItems = courses.filter((c) => c.level === "beginner").map(courseToItem);

  const advancedItems = courses.filter((c) => c.level === "advanced").map(courseToItem);

  return defineManifest({
    snapshotId: `courses-${Date.now()}`,
    namespaces: [
      { key: "courses.beginner", label: "Beginner Courses", items: beginnerItems },
      { key: "courses.advanced", label: "Advanced Courses", items: advancedItems },
    ],
  });
}

function courseToItem(course: ApiCourse) {
  const videoAsset = defineManifestAsset({
    id: "video",
    role: "primary",
    kind: "video",
    mimeType: "video/mp4",
    source: { url: course.videoUrl },
  });

  const posterAsset = defineManifestAsset({
    id: "poster",
    role: "poster",
    kind: "poster",
    source: { url: course.posterUrl },
  });

  const assets = [videoAsset, posterAsset];

  if (course.subtitleUrl) {
    assets.push(
      defineManifestAsset({
        id: "subs-en",
        role: "subtitle",
        kind: "subtitle",
        fileName: "en.vtt",
        source: { url: course.subtitleUrl },
      }),
    );
  }

  return defineManifestItem({
    id: course.id,
    version: course.revision,
    kind: "video",
    title: course.title,
    assets,
  });
}
```

## Core Patterns

### Dot-delimited namespace hierarchies

Use dot notation for hierarchical organization. `useMedia({ kind: "list", namespace: "courses", recursive: true })` queries all nested namespaces.

```typescript
import { defineManifest } from "@rockhallweb/electron-offline-content/main";

defineManifest({
  namespaces: [
    { key: "courses", label: "All Courses", items: [] },
    { key: "courses.beginner", label: "Beginner", items: beginnerItems },
    { key: "courses.beginner.featured", label: "Featured Beginner", items: featuredItems },
    { key: "courses.advanced", label: "Advanced", items: advancedItems },
  ],
});
```

```typescript
// In renderer — queries courses.beginner, courses.beginner.featured, courses.advanced
const allCourses = useMedia({ kind: "list", namespace: "courses", recursive: true });
const beginnerOnly = useMedia({ kind: "list", namespace: "courses.beginner" });
```

### Shorthand manifest inputs

`resolveManifest` can return three shapes. The library normalizes all of them.

```typescript
import type {
  MediaCacheManifest,
  MediaNamespaceDefinition,
  MediaContentDefinition,
} from "@rockhallweb/electron-offline-content/main";

// Shape 1: full manifest with snapshotId
const full: MediaCacheManifest = defineManifest({
  snapshotId: "v42",
  namespaces: [
    { key: "exhibits", items: exhibitItems },
    { key: "programs", items: programItems },
  ],
});

// Shape 2: namespace array (normalized into a manifest internally)
const namespaces: MediaNamespaceDefinition[] = [
  { key: "exhibits", items: exhibitItems },
  { key: "programs", items: programItems },
];

// Shape 3: flat item array (all go into a single auto-generated namespace)
const items: MediaContentDefinition[] = [item1, item2, item3];
```

### Version-driven cache busting

When an item's `version` changes, all its assets are re-downloaded. Items with unchanged versions keep their cached blobs.

```typescript
import { defineManifestItem } from "@rockhallweb/electron-offline-content/main";

defineManifestItem({
  id: "welcome-video",
  version: apiEntry.updatedAt, // timestamp-based: "2026-03-15T08:30:00Z"
  kind: "video",
  assets,
});

defineManifestItem({
  id: "floor-map",
  version: apiEntry.contentMd5, // content-hash: "a1b2c3d4e5f6"
  kind: "image",
  assets,
});
```

### Multi-asset items

An item can have multiple assets with different roles. Use `assetsByRole` in the renderer for role-based lookup.

```typescript
import {
  defineManifestItem,
  defineManifestAsset,
} from "@rockhallweb/electron-offline-content/main";

const inducteeItem = defineManifestItem({
  id: "inductee-2026-beyonce",
  version: "3",
  kind: "video",
  title: "Beyoncé Induction Ceremony",
  assets: [
    defineManifestAsset({
      id: "main-video",
      role: "primary",
      kind: "video",
      mimeType: "video/mp4",
      source: { url: "https://cdn.example.com/beyonce-ceremony.mp4" },
    }),
    defineManifestAsset({
      id: "poster",
      role: "poster",
      kind: "poster",
      source: { url: "https://cdn.example.com/beyonce-poster.jpg" },
    }),
    defineManifestAsset({
      id: "subs-en",
      role: "subtitle",
      kind: "subtitle",
      fileName: "en.vtt",
      source: { url: "https://cdn.example.com/beyonce-en.vtt" },
    }),
    defineManifestAsset({
      id: "subs-es",
      role: "subtitle-es",
      kind: "subtitle",
      fileName: "es.vtt",
      source: { url: "https://cdn.example.com/beyonce-es.vtt" },
    }),
  ],
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

### HIGH: Duplicate namespace keys in manifest

`normalizeManifest` throws `ManifestValidationError` when two namespaces share a key.

```typescript
// WRONG — duplicate key "videos"
defineManifest({
  namespaces: [
    { key: "videos", items: featuredVideos },
    { key: "videos", items: archiveVideos },
  ],
});
```

```typescript
// CORRECT — distinct keys
defineManifest({
  namespaces: [
    { key: "videos.featured", items: featuredVideos },
    { key: "videos.archive", items: archiveVideos },
  ],
});
```

Source: normalize.ts

### HIGH: Omitting required item version field

`version` is required (min length 1) and drives cache busting. Fails Zod validation at manifest build time.

```typescript
// WRONG — missing version
defineManifestItem({
  id: "welcome",
  kind: "video",
  assets,
});
```

```typescript
// CORRECT — version present
defineManifestItem({
  id: "welcome",
  version: "2026-03-15",
  kind: "video",
  assets,
});
```

Source: normalize.ts; validation.ts

### HIGH: Asset URL without filename in path

When `fileName` is omitted, it is derived from the URL basename. URLs ending in `/` or with no parseable filename fail derivation.

```typescript
// WRONG — URL has no filename to derive
defineManifestAsset({
  id: "video",
  role: "primary",
  kind: "video",
  source: { url: "https://cdn.example.com/api/stream/" },
});
```

```typescript
// CORRECT — explicit fileName when URL lacks one
defineManifestAsset({
  id: "video",
  role: "primary",
  kind: "video",
  fileName: "ceremony.mp4",
  source: { url: "https://cdn.example.com/api/stream/" },
});

// ALSO CORRECT — URL with a parseable basename
defineManifestAsset({
  id: "video",
  role: "primary",
  kind: "video",
  source: { url: "https://cdn.example.com/media/ceremony.mp4" },
});
```

Source: internal/asset-file-name.ts

### HIGH: Deep nesting instead of using producer helpers

Inlining deeply nested objects into a single `defineManifest` call obscures validation errors. The helpers validate each piece individually with clearer messages.

```typescript
// WRONG — one giant inline object, validation errors point to root
defineManifest({
  namespaces: [
    {
      key: "videos",
      items: [
        {
          id: "intro",
          version: "1",
          kind: "video",
          assets: [
            {
              id: "main",
              role: "primary",
              kind: "video",
              source: { url: "https://cdn.example.com/intro.mp4" },
            },
          ],
        },
      ],
    },
  ],
});
```

```typescript
// CORRECT — flat composition, each piece validated independently
const mainAsset = defineManifestAsset({
  id: "main",
  role: "primary",
  kind: "video",
  source: { url: "https://cdn.example.com/intro.mp4" },
});

const introItem = defineManifestItem({
  id: "intro",
  version: "1",
  kind: "video",
  assets: [mainAsset],
});

const manifest = defineManifest({
  namespaces: [{ key: "videos", items: [introItem] }],
});
```

Source: Maintainer interview; README

### MEDIUM: Using non-HTTP asset source URLs

Zod validation enforces `http://` or `https://` schemes. `file://`, `data:`, `blob:` are rejected.

```typescript
// WRONG — file:// rejected
defineManifestAsset({
  id: "local-video",
  role: "primary",
  kind: "video",
  source: { url: "file:///Users/media/video.mp4" },
});
```

```typescript
// CORRECT — https://
defineManifestAsset({
  id: "cdn-video",
  role: "primary",
  kind: "video",
  source: { url: "https://cdn.example.com/video.mp4" },
});
```

Source: validation.ts

### MEDIUM: Duplicate item IDs within namespace

Item IDs must be unique per namespace. Transforming API data without deduplication causes collisions.

Wrong:

```typescript
const items = apiEntries.map((entry) =>
  defineManifestItem({
    id: "intro",
    version: entry.revision,
    kind: "video",
    assets: [
      defineManifestAsset({
        id: "main",
        role: "primary",
        kind: "video",
        source: { url: entry.videoUrl },
      }),
    ],
  }),
);
```

Correct:

```typescript
const items = apiEntries.map((entry) =>
  defineManifestItem({
    id: entry.slug,
    version: entry.revision,
    kind: "video",
    assets: [
      defineManifestAsset({
        id: "main",
        role: "primary",
        kind: "video",
        source: { url: entry.videoUrl },
      }),
    ],
  }),
);
```

Source: normalize.ts

### MEDIUM: Over-namespacing with too many granular namespaces

Creating a namespace for every few items adds overhead without value. Namespaces are for app sections, not for grouping 2–3 items.

```typescript
defineManifest({
  namespaces: [
    { key: "exhibits.guitars.fender", items: [fenderItem] },
    { key: "exhibits.guitars.gibson", items: [gibsonItem] },
    { key: "exhibits.guitars.rickenbacker", items: [rickenbackerItem] },
  ],
});
```

Correct:

```typescript
defineManifest({
  namespaces: [{ key: "exhibits.guitars", items: [fenderItem, gibsonItem, rickenbackerItem] }],
});
```

Source: Maintainer interview

### HIGH Tension: Manifest flexibility vs validation strictness

`resolveManifest` accepts multiple input shapes for convenience, but validation is strict on uniqueness and required fields. Using flexible shorthand inputs without required fields like `version` causes errors at sync time, not definition time.

See also: getting-started/SKILL.md § Common Mistakes

### HIGH Tension: Manifest-time auth vs download-time auth

Pre-signed URLs set at manifest build time are simple but have a TTL ceiling — the expiration must cover the entire download queue. For large catalogs, prefer download-time signing via `resolveAssetRequest`.

See also: authenticated-downloads/SKILL.md § Common Mistakes

## Cross-References

See also: getting-started/SKILL.md — Full main → preload → renderer wiring
See also: react-rendering/SKILL.md — Namespace organization determines how hooks query content
See also: authenticated-downloads/SKILL.md — Auth strategies for asset sources
