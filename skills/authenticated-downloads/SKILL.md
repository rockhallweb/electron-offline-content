---
name: authenticated-downloads
description: >
  Adding authentication to asset downloads in the flat store model by
  embedding presigned (or otherwise signed) URLs in each asset’s top-level
  url field during resolveStore. Pre-signed URL expiration vs catalog sync
  duration tradeoff.
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
import { createMediaCache, createMediaStore } from "@rockhall/electron-offline-content/main";
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

      store.add(["assets", item.id], {
        version: item.revision,
        mimeType: "video/mp4",
        url: signedUrl,
        metadata: item.metadata,
      });
    }

    return store;
  },
});
```

## Core Patterns

### Embedding presigned URLs in resolveStore

All authentication is handled during `resolveStore()`. The download pipeline fetches each asset using only its `url` string. Put signing parameters, tokens, or credentials into that URL (for example an S3 presigned URL) before calling `store.add`.

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

    store.add(["assets", item.id], {
      version: item.revision,
      mimeType: "video/mp4",
      url: signedUrl,
    });
  }

  return store;
}
```

### OAuth or rotating credentials

If you use short-lived tokens, exchange them for presigned download URLs (or a backend-issued URL that already includes auth) inside `resolveStore` before calling `store.add`. The library does not accept separate auth configuration per asset—only the final URL string.

### TTL and catalog size

| Scenario            | Recommendation                                                                   |
| ------------------- | -------------------------------------------------------------------------------- |
| Any protected asset | Presign (or otherwise embed auth in) the `url` before `store.add`.               |
| Small catalog       | Presign in `resolveStore` with a TTL that comfortably exceeds full sync time.    |
| Large catalog       | Use a long TTL and set store `expiresAt` to match for fail-fast `STORE_EXPIRED`. |

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
    store.add(["assets", item.id], { version: item.rev, mimeType: "video/mp4", url: signedUrl });
  }
  return store;
}
```

Correct — generous TTL with `expiresAt`:

```typescript
async function resolveStore() {
  const ttlSeconds = 3600;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const store = createMediaStore({ expiresAt });

  for (const item of await fetchCatalog()) {
    const signedUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: "b", Key: item.key }), {
      expiresIn: ttlSeconds,
    });
    store.add(["assets", item.id], {
      version: item.rev,
      mimeType: "video/mp4",
      url: signedUrl,
    });
  }

  return store;
}
```

Source: Maintainer interview

### HIGH: Auth not tested in offline mode

In dev passthrough mode, assets load from their original remote URLs directly in the renderer. Auth issues only surface when `devPassthrough` is `false` and the main process downloads assets using the URLs from `resolveStore`.

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

### HIGH Tension: Pre-signed URL TTL vs catalog size

Pre-signed URLs embedded at store build time are simple but have a TTL ceiling: expiration must cover the entire download queue. For large catalogs, evaluate expected sync duration and set TTLs accordingly. Use store `expiresAt` for fail-fast behavior.

See also: store-authoring/SKILL.md § Common Mistakes

### HIGH Tension: Dev passthrough simplicity vs production correctness

`devPassthrough` bypasses downloads entirely. Code that works in dev (where auth isn't needed for public URLs) may fail in production when assets require signed downloads.

See also: cache-configuration/SKILL.md § Common Mistakes

---

See also: store-authoring/SKILL.md — Asset URL definition and resolveStore
See also: cache-configuration/SKILL.md — devPassthrough mode bypasses downloads
See also: production-checklist/SKILL.md — Verify auth works in offline mode before deploy
