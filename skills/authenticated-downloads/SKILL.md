---
name: authenticated-downloads
description: >
  Adding authentication to asset downloads in the flat store model.
  Embedding signed URLs in source.url during resolveStore for
  per-asset pre-signed URL generation. Using source.headers for
  static auth tokens at store build time. Choosing between
  store-time pre-signed URLs (simple, TTL-limited) and static
  headers (long-lived tokens). Pre-signed URL expiration vs catalog
  sync duration tradeoff.
type: core
library: electron-offline-content
library_version: "0.4.0"
requires:
  - store-authoring
sources:
  - "rockhallweb/electron-offline-content:src/main/media-cache.ts"
  - "rockhallweb/electron-offline-content:src/main/store.ts"
  - "rockhallweb/electron-offline-content:src/shared/types.ts"
  - "rockhallweb/electron-offline-content:README.md"
---

> **Dependency:** This skill builds on store-authoring. Read it first for resolveStore and createMediaStore patterns.

## Setup

A `resolveStore` function that embeds S3 pre-signed URLs at store build time:

```typescript
import { createMediaCache, createMediaStore } from "@rockhallweb/electron-offline-content/main";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "us-east-1" });

const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  resolveStore: async () => {
    const store = createMediaStore();
    const catalog = await fetchCatalog();

    for (const item of catalog) {
      const signedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: "my-content-bucket",
          Key: item.objectKey,
        }),
        { expiresIn: 3600 },
      );

      store.add({
        key: item.id,
        version: item.revision,
        kind: "video",
        mimeType: "video/mp4",
        source: { url: signedUrl },
        metadata: item.metadata,
      });
    }

    return store;
  },
});
```

## Core Patterns

### Embedding signed URLs in resolveStore

All authentication is handled during `resolveStore()`. Embed signed URLs directly in each asset's `source.url`. The download pipeline uses these URLs as-is.

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

### Static headers on asset sources

For long-lived API keys or bearer tokens, set `headers` directly on each asset's `source`. Simpler than pre-signing every URL.

```typescript
import { createMediaStore } from "@rockhallweb/electron-offline-content/main";

async function resolveStore() {
  const store = createMediaStore();
  const catalog = await fetchCatalog();

  for (const item of catalog) {
    store.add({
      key: item.id,
      version: item.revision,
      kind: "video",
      mimeType: "video/mp4",
      source: {
        url: `https://cdn.example.com/${item.objectKey}`,
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
    });
  }

  return store;
}
```

### Bearer token injection

For OAuth or rotating tokens, fetch a fresh token at the start of `resolveStore` and embed it in headers on every asset:

```typescript
async function resolveStore() {
  const token = await fetchOAuthToken();
  const store = createMediaStore();

  for (const item of await fetchCatalog()) {
    store.add({
      key: item.id,
      version: item.revision,
      kind: "video",
      mimeType: "video/mp4",
      source: {
        url: item.downloadUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    });
  }

  return store;
}
```

The token must remain valid for the duration of the sync. For large catalogs, use a token with a generous TTL.

### Choosing between strategies

| Credential type          | Catalog size         | Recommended approach                          |
| ------------------------ | -------------------- | --------------------------------------------- |
| Long-lived API key/token | Any                  | `source.headers` on each asset                |
| Short-lived S3 URL       | Small (< 100 assets) | Pre-sign in `resolveStore` with generous TTL  |
| Short-lived S3 URL       | Large (100+ assets)  | Pre-sign with long TTL + store `expiresAt`    |
| OAuth / rotating token   | Any                  | Fetch token at start of `resolveStore`, embed |

## Common Mistakes

### HIGH: Pre-signed URL expiration too short for full catalog sync

When embedding pre-signed URLs in `resolveStore`, the TTL must exceed total download time for **all** assets. Assets late in the queue fail with opaque HTTP 403 when URLs expire mid-sync.

Set `expiresAt` on the store to the earliest shared expiration timestamp so the cache can fail fast with `STORE_EXPIRED` before a later asset is fetched with a stale URL.

Wrong — short TTL on a large catalog:

```typescript
async function resolveStore() {
  const store = createMediaStore();
  for (const item of await fetchCatalog()) {
    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: "b", Key: item.key }),
      { expiresIn: 300 }, // 5 minutes — too short for 500 assets
    );
    store.add({ key: item.id, version: item.rev, kind: "video", source: { url: signedUrl } });
  }
  return store;
}
```

Correct — generous TTL with `expiresAt`:

```typescript
async function resolveStore() {
  const store = createMediaStore();
  const ttlSeconds = 3600;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  for (const item of await fetchCatalog()) {
    const signedUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: "b", Key: item.key }), {
      expiresIn: ttlSeconds,
    });
    store.add({ key: item.id, version: item.rev, kind: "video", source: { url: signedUrl } });
  }

  store.expiresAt = expiresAt;
  return store;
}
```

Source: Maintainer interview

### HIGH: Auth not tested in offline mode

In dev passthrough mode, assets load from their original remote URLs directly in the renderer. Auth issues only surface when `devPassthrough` is `false` and the main process downloads assets using the signed URLs or headers from `resolveStore`.

Wrong — testing only in dev passthrough:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: true,
  resolveStore: async () => buildAuthenticatedStore(),
});
// "It works!" — but auth URLs are never actually used for downloads
```

Correct — test with `devPassthrough: false` to verify auth:

```typescript
const mediaCache = createMediaCache({
  storagePath: { appPath: "userData", segments: ["offline-media"] },
  devPassthrough: false,
  resolveStore: async () => buildAuthenticatedStore(),
});
```

Source: README
Cross-skill: cache-configuration/SKILL.md § Common Mistakes

### MEDIUM: Using pre-signed URLs for long-lived static tokens

Pre-signing every URL adds complexity and creates TTL management overhead. If the token is long-lived, `source.headers` is simpler.

Wrong:

```typescript
async function resolveStore() {
  const store = createMediaStore();
  for (const item of await fetchCatalog()) {
    const signedUrl = signUrlWithStaticKey(item.url, STATIC_API_KEY);
    store.add({ key: item.id, version: item.rev, kind: "video", source: { url: signedUrl } });
  }
  return store;
}
```

Correct — set headers on asset sources in the store:

```typescript
async function resolveStore() {
  const store = createMediaStore();
  for (const item of await fetchCatalog()) {
    store.add({
      key: item.id,
      version: item.rev,
      kind: "video",
      source: {
        url: item.url,
        headers: { Authorization: `Bearer ${STATIC_API_KEY}` },
      },
    });
  }
  return store;
}
```

Source: README

### HIGH Tension: Pre-signed URL TTL vs catalog size

Pre-signed URLs embedded at store build time are simple but have a TTL ceiling: expiration must cover the entire download queue. For large catalogs, evaluate expected sync duration and set TTLs accordingly. Use store `expiresAt` for fail-fast behavior.

See also: store-authoring/SKILL.md § Common Mistakes

### HIGH Tension: Dev passthrough simplicity vs production correctness

`devPassthrough` bypasses downloads entirely. Code that works in dev (where auth isn't needed for public URLs) may fail in production when assets require signed downloads or auth headers.

See also: cache-configuration/SKILL.md § Common Mistakes

---

See also: store-authoring/SKILL.md — Asset source definition and headers
See also: cache-configuration/SKILL.md — devPassthrough mode bypasses downloads
See also: production-checklist/SKILL.md — Verify auth works in offline mode before deploy
