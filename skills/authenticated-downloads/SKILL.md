---
name: authenticated-downloads
description: >
  Adding authentication to asset downloads: resolveAssetRequest callback
  for per-asset signed URL generation and bearer token injection,
  ResolveAssetRequestContext and DownloadRequest types,
  MediaRemoteSource.headers for static auth at manifest build time.
  Choosing between manifest-time pre-signed URLs (simple, TTL-limited)
  and download-time signing via resolveAssetRequest (robust, not
  available in devPassthrough). Pre-signed URL expiration vs catalog
  sync duration tradeoff.
type: core
library: electron-offline-content
library_version: "0.1.1"
requires:
  - manifest-authoring
sources:
  - "rockhallweb/electron-offline-content:src/main/media-cache.ts"
  - "rockhallweb/electron-offline-content:src/shared/types.ts"
  - "rockhallweb/electron-offline-content:README.md"
---

> **Dependency:** This skill builds on manifest-authoring. Read it first for resolveManifest and define helpers.

## Setup

A `createMediaCache` with `resolveAssetRequest` that generates S3 pre-signed URLs at download time:

```typescript
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "us-east-1" });

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveAssetRequest: async (ctx) => ({
    url: await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: "my-content-bucket",
        Key: ctx.asset.source.url.replace("https://my-content-bucket.s3.amazonaws.com/", ""),
      }),
      { expiresIn: 3600 },
    ),
  }),
  resolveManifest: async () => fetchManifest(),
});
```

## Core Patterns

### Download-time signing with resolveAssetRequest

Called per-asset per-sync. Returns a `DownloadRequest` with a signed URL and/or custom headers. Best for short-lived credentials or large catalogs where manifest-time URLs may expire before all downloads complete.

```typescript
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";
import type {
  ResolveAssetRequestContext,
  DownloadRequest,
} from "@rockhallweb/electron-offline-content/main";

async function signAssetRequest(ctx: ResolveAssetRequestContext): Promise<DownloadRequest> {
  const token = await fetchShortLivedToken();
  return {
    url: ctx.asset.source.url,
    headers: { Authorization: `Bearer ${token}` },
  };
}

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveAssetRequest: signAssetRequest,
  resolveManifest: async () => fetchManifest(),
});
```

### Static headers on asset sources

For long-lived API keys or bearer tokens known at manifest build time, set `headers` directly on each asset's `source`. Simpler than `resolveAssetRequest` — no per-download callback.

```typescript
import { defineManifestAsset } from "@rockhallweb/electron-offline-content/main";

defineManifestAsset({
  id: "main",
  role: "primary",
  kind: "video",
  source: {
    url: "https://cdn.example.com/video.mp4",
    headers: { Authorization: `Bearer ${API_KEY}` },
  },
});
```

### Choosing between strategies

| Credential type            | Catalog size         | Recommended approach                              |
| -------------------------- | -------------------- | ------------------------------------------------- |
| Long-lived API key/token   | Any                  | `source.headers` on each asset                    |
| Short-lived pre-signed URL | Small (< 100 assets) | Pre-sign at manifest build time with generous TTL |
| Short-lived pre-signed URL | Large (100+ assets)  | `resolveAssetRequest` for download-time signing   |
| OAuth / rotating token     | Any                  | `resolveAssetRequest` with token refresh          |

## Common Mistakes

### HIGH: Expecting resolveAssetRequest to work in devPassthrough

In dev passthrough mode, `resolveAssetRequest` is **never called**. Passthrough uses manifest source URLs directly. Assets requiring auth will fail silently — broken images and video with no error in application logs.

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: true,
  resolveAssetRequest: async (ctx) => ({
    url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: "b", Key: "k" }), {
      expiresIn: 3600,
    }),
  }),
  resolveManifest: async () => fetchManifest(),
});
```

Correct — disable passthrough when using `resolveAssetRequest` for auth:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  resolveAssetRequest: async (ctx) => ({
    url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: "b", Key: "k" }), {
      expiresIn: 3600,
    }),
  }),
  resolveManifest: async () => fetchManifest(),
});
```

Source: README
Cross-skill: cache-configuration/SKILL.md § Common Mistakes

### HIGH: Pre-signed URL expiration too short for full catalog sync

When using manifest-time pre-signed URLs, the TTL must exceed total download time for **all** assets. Assets late in the queue fail with opaque HTTP 403 when URLs expire mid-sync.

If you must ship pre-signed URLs in the manifest, set top-level `expiresAt` to the earliest shared expiration timestamp so the cache can fail fast with `MANIFEST_EXPIRED` before a later asset request is resolved or fetched with a stale URL.

Wrong — 15-minute TTL for a catalog that takes 2 hours to sync:

```typescript
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

async function resolveManifest() {
  const items = await fetchCatalog();
  return Promise.all(
    items.map(async (item) => ({
      id: item.id,
      version: item.revision,
      kind: "video" as const,
      assets: [
        {
          id: "main",
          role: "primary",
          kind: "video",
          source: {
            url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: "b", Key: item.key }), {
              expiresIn: 900,
            }),
          },
        },
      ],
    })),
  );
}
```

Correct — generous expiration plus `expiresAt`, or download-time signing:

```typescript
// Option A: generous TTL (24 hours) for small catalogs, plus manifest.expiresAt
const ttlSeconds = 86400;
const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

async function resolveManifest() {
  const items = await fetchCatalog();
  return {
    expiresAt, // fail fast once shared URL TTL lapses
    namespaces: [
      {
        key: "exhibits",
        items: await Promise.all(
          items.map(async (item) => ({
            id: item.id,
            version: item.revision,
            kind: "video" as const,
            assets: [
              {
                id: "main",
                role: "primary",
                kind: "video",
                source: {
                  url: await getSignedUrl(
                    s3,
                    new GetObjectCommand({ Bucket: "b", Key: item.key }),
                    { expiresIn: ttlSeconds },
                  ),
                },
              },
            ],
          })),
        ),
      },
    ],
  };
}

// Option B: use resolveAssetRequest for large catalogs — signs each URL
// at download time so TTL pressure is per-asset, not per-manifest.
// See the Setup section for resolveAssetRequest wiring.
```

Source: Maintainer interview

### MEDIUM: Confusing resolveAssetRequest with resolveManifest

`resolveManifest` produces the full content catalog. `resolveAssetRequest` customizes individual download requests. Putting auth logic in the wrong callback breaks either manifest fetching or asset downloading.

Wrong — signing individual URLs inside `resolveManifest`:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveManifest: async () => {
    const items = await fetchCatalog();
    return Promise.all(
      items.map(async (item) => ({
        id: item.id,
        version: item.revision,
        kind: "video" as const,
        assets: [
          {
            id: "main",
            role: "primary",
            kind: "video",
            source: {
              url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: "b", Key: item.key }), {
                expiresIn: 900,
              }),
            },
          },
        ],
      })),
    );
  },
});
```

Correct — manifest returns plain URLs, `resolveAssetRequest` handles signing:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveManifest: async () => {
    const items = await fetchCatalog();
    return items.map((item) => ({
      id: item.id,
      version: item.revision,
      kind: "video" as const,
      assets: [
        {
          id: "main",
          role: "primary",
          kind: "video",
          source: { url: `https://my-content-bucket.s3.amazonaws.com/${item.key}` },
        },
      ],
    }));
  },
  resolveAssetRequest: async (ctx) => ({
    url: await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: "my-content-bucket",
        Key: ctx.asset.source.url.replace("https://my-content-bucket.s3.amazonaws.com/", ""),
      }),
      { expiresIn: 3600 },
    ),
  }),
});
```

Source: types.ts; README

### MEDIUM: Using resolveAssetRequest for long-lived static tokens

`resolveAssetRequest` is called per-asset per-sync. If the token is long-lived, `source.headers` is simpler and avoids unnecessary callback overhead.

Wrong:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveAssetRequest: async (ctx) => ({
    url: ctx.asset.source.url,
    headers: { Authorization: `Bearer ${STATIC_API_KEY}` },
  }),
  resolveManifest: async () => fetchManifest(),
});
```

Correct — set headers on asset sources in the manifest:

```typescript
import { defineManifestAsset } from "@rockhallweb/electron-offline-content/main";

defineManifestAsset({
  id: "main",
  role: "primary",
  kind: "video",
  source: {
    url: "https://cdn.example.com/video.mp4",
    headers: { Authorization: `Bearer ${STATIC_API_KEY}` },
  },
});
```

Source: README

### HIGH Tension: Manifest-time auth vs download-time auth

Pre-signed URLs at manifest build time are simple but have a TTL ceiling: expiration must cover the entire download queue. `resolveAssetRequest` signs at download time (no expiration risk) but adds per-asset callback overhead and does not work in `devPassthrough` mode. Evaluate catalog size and expected sync duration.

See also: manifest-authoring/SKILL.md § Common Mistakes

### HIGH Tension: Dev passthrough simplicity vs production correctness

`devPassthrough` bypasses `resolveAssetRequest` entirely. Code that works in dev (where auth isn't needed for public URLs) may fail in production when assets require signed downloads.

See also: cache-configuration/SKILL.md § Common Mistakes

---

See also: manifest-authoring/SKILL.md — Asset source definition and headers
See also: cache-configuration/SKILL.md — devPassthrough mode disables resolveAssetRequest
See also: production-checklist/SKILL.md — Verify auth works in offline mode before deploy
