# `@rockhallweb/electron-offline-content` Design Draft

## Purpose

`@rockhallweb/electron-offline-content` is a TypeScript package for Electron apps that
downloads, stages, indexes, and serves offline-ready content to a renderer with minimal
consumer plumbing.

The target use case is kiosk-style Electron apps where:

- a full catalog sync at launch is acceptable
- media files may be large, especially video
- the renderer should consume local content through a clean API
- the app should remain functional offline after a successful sync

This package is opinionated. It codifies a specific content-sync model rather than
trying to be a general-purpose cache layer.

## Confirmed Decisions

- Electron latest stable is the minimum supported runtime.
- The package is authored fully in TypeScript and intended for TypeScript consumers.
- `pnpm` must be supported.
- Large binary assets are stored on disk, not in the database.
- Structured metadata and text blobs are stored in SQLite.
- SQLite implementation for first release: `node:sqlite`.
- The renderer should not be given raw filesystem paths as the main API.
- Files should be exposed through a custom privileged protocol such as `media://`.
- Downloads are atomic: temp file, flush, close, rename.
- Sync progress is owned by the main process and streamed to renderers.
- Diffing is based on logical IDs plus consumer-owned version keys.
- The package does not validate ETags or checksums in the first release.
- Orphaned assets are not deleted immediately. They are marked for deletion and pruned
  after a configurable grace period.
- On sync failure, default behavior is to keep serving the last committed snapshot.
- Consumers may opt into fail-fast behavior instead.

## Recommended Package Shape

Start as one package with subpath exports:

- `@rockhallweb/electron-offline-content/main`
- `@rockhallweb/electron-offline-content/preload`
- `@rockhallweb/electron-offline-content/react`

This keeps installation simple while still separating the main-process, preload, and
React-facing APIs.

## Storage Model

### Disk

Store large binaries as regular files on disk.

Recommended directory layout:

```text
<storageRoot>/
  blobs/
    <namespace>/
      <itemId>/
        <assetId>/
          <version>/<filename>
  temp/
  sqlite/
    media-cache.db
```

### Database

Store these in SQLite:

- namespaces
- content items
- asset index rows
- text blobs and metadata
- sync generations / committed snapshots
- pending deletions and their expiry
- sync progress state
- download error records

### Default Storage Root

Do not default to `app.getPath('userData')`. Electron explicitly warns that large
files should not be written there because some environments back that directory up to
cloud storage.

Instead, the package should compute an OS-appropriate cache directory by default and
allow override:

- macOS: `~/Library/Caches/<AppName>/media-cache`
- Windows: `%LOCALAPPDATA%/<AppName>/media-cache`
- Linux: `$XDG_CACHE_HOME/<appName>/media-cache` or `~/.cache/<appName>/media-cache`

Consumers can override this with an absolute `storageRoot`.

## Core Identity Model

There are two different identities that must remain distinct.

### Logical identity

Logical identity determines what the thing is:

`namespace + item.id + asset.id`

This is used for diffing the latest remote snapshot against the local catalog.

### Cache identity

Cache identity determines whether the bytes should be reused:

`namespace + item.id + asset.id + resolvedVersion`

Where `resolvedVersion` is:

- `asset.version` when defined
- otherwise `item.version`

This keeps the cache-busting contract explicit and consumer-owned.

## Manifest Contract

The sync callback should return a full authoritative snapshot, not a partial page.
That keeps diffing deterministic.

To support both flat catalogs and namespaced catalogs, the package should accept three
equivalent forms:

1. A full manifest object
2. An array of namespace objects
3. A flat array of content items, which the package normalizes into the `default`
   namespace

Validation rules:

- namespace keys must be unique
- item IDs must be unique within a namespace
- asset IDs must be unique within an item
- duplicate logical identities are a manifest error
- the manifest callback is treated as authoritative for the full catalog represented by
  that sync

### Proposed Types

```ts
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MediaKind = "video" | "image" | "audio" | "document" | "html" | "text" | "binary";

export interface MediaCacheManifest {
  snapshotId?: string;
  generatedAt?: string;
  namespaces: MediaNamespaceDefinition[];
}

export interface MediaNamespaceDefinition {
  key: string;
  label?: string;
  metadata?: Record<string, JsonValue>;
  items: MediaContentDefinition[];
}

export interface MediaContentDefinition {
  id: string;
  version: string;
  kind: MediaKind;
  title?: string;
  description?: string;
  summary?: string;
  blobs?: Record<string, string>;
  metadata?: Record<string, JsonValue>;
  assets: MediaAssetDefinition[];
}

export interface MediaAssetDefinition {
  id: string;
  role: string;
  kind: MediaKind | "subtitle" | "caption" | "poster" | "thumbnail";
  version?: string;
  mimeType?: string;
  fileName?: string;
  byteLength?: number;
  source: MediaRemoteSource;
  metadata?: Record<string, JsonValue>;
}

export interface MediaRemoteSource {
  url: string;
  method?: "GET";
  headers?: Record<string, string>;
}
```

### Example normalized manifest

```ts
const manifest: MediaCacheManifest = {
  snapshotId: "2026-03-16T17:00:00Z",
  namespaces: [
    {
      key: "lobby",
      label: "Lobby Kiosk",
      items: [
        {
          id: "spring-campaign",
          version: "2026-03-10.1",
          kind: "video",
          title: "Spring Campaign",
          description: "Primary looping campaign video for the lobby display.",
          blobs: {
            captionText: "Welcome to the Rock Hall",
          },
          metadata: {
            cmsEntryId: "abc123",
          },
          assets: [
            {
              id: "main",
              role: "primary",
              kind: "video",
              mimeType: "video/mp4",
              fileName: "spring-campaign.mp4",
              byteLength: 238472193,
              source: {
                url: "https://cdn.example.com/assets/spring-campaign.v2026-03-10.mp4",
                headers: {
                  Authorization: "Bearer <token>",
                },
              },
            },
            {
              id: "poster",
              role: "poster",
              kind: "poster",
              mimeType: "image/jpeg",
              fileName: "spring-campaign-poster.jpg",
              source: {
                url: "https://cdn.example.com/assets/spring-campaign-poster.v4.jpg",
              },
            },
            {
              id: "en-subtitles",
              role: "subtitle",
              kind: "subtitle",
              mimeType: "text/vtt",
              fileName: "spring-campaign.en.vtt",
              source: {
                url: "https://cdn.example.com/assets/spring-campaign.en.vtt",
              },
            },
          ],
        },
      ],
    },
  ],
};
```

### Notes

- `namespace.key` is optional in spirit but not in normalized storage. The package can
  synthesize `default` when consumers pass a flat item array.
- `item.version` is required because the package is intentionally version-driven.
- `asset.version` is optional to avoid making simple manifests noisy.
- `blobs` are for inline text content that belongs in SQLite rather than as files.
- `byteLength` is optional but strongly recommended when consumers know it, because it
  improves disk-space estimation and progress reporting.

## Auth and Request Model

Do not limit the manifest to plain URLs only. The package should accept a request
descriptor, not just a string.

For first release, the manifest-level asset source can be:

- `url`
- optional `headers`
- optional `method`

That covers:

- static public URLs
- CMS/CDN URLs with bearer tokens
- signed URLs generated by the manifest callback
- tenant-specific headers

To support short-lived auth without overcomplicating the manifest, leave room for an
optional just-in-time request hook in config:

```ts
export interface ResolveAssetRequestContext {
  namespace: MediaNamespaceDefinition
  item: MediaContentDefinition
  asset: MediaAssetDefinition
}

export interface DownloadRequest {
  url: string
  method?: 'GET'
  headers?: Record<string, string>
}

resolveAssetRequest?: (
  ctx: ResolveAssetRequestContext
) => Promise<DownloadRequest> | DownloadRequest
```

Resolution rules:

1. If `resolveAssetRequest` exists, it can augment or replace the manifest-provided
   request.
2. Otherwise, the package uses `asset.source` as-is.

This gives consumers a clean path for expiring tokens and signed-request generation
without making the base manifest too abstract.

## Sync Lifecycle

### High-level flow

1. Load the last committed snapshot from SQLite.
2. Resolve the latest remote manifest.
3. Validate and normalize the manifest into namespace form.
4. Build a staged generation in SQLite.
5. Diff staged generation against the committed generation.
6. Estimate required disk space when possible.
7. Download missing or version-changed assets to temp files.
8. Atomically promote completed downloads into the blob store.
9. Commit the new generation in SQLite.
10. Mark no-longer-present logical assets for deletion after the grace period.
11. Prune expired pending deletions.
12. Broadcast final sync status.

### Failure behavior

On failure before commit:

- the previous committed snapshot remains the active snapshot
- partially downloaded temp files are cleaned up
- pending deletions are not applied to active content

Configurable behavior:

- default: `serve-last-snapshot`
- optional: `throw`

`throw` means the package exposes the sync failure instead of silently serving the last
snapshot. It should not mean "commit a partial generation".

## Deletion Policy

If a logical asset disappears from the latest authoritative snapshot, do not remove it
immediately.

Instead:

1. mark it `pending_deletion_at = now`
2. compute `delete_after = pending_deletion_at + gracePeriod`
3. keep serving the last committed snapshot until a newer committed snapshot becomes
   active
4. prune only after `delete_after`

Default grace period: `7 days`

This protects against:

- temporary upstream manifest issues
- accidental operator mistakes
- intermittent CMS publishing problems

## Video Delivery Contract

Video is a first-class use case, so the local delivery path has to preserve seeking and
range behavior.

Recommendation:

- expose local media through a custom privileged protocol, e.g. `media://`
- have the protocol resolve to committed local files only
- avoid serving in-progress temp paths
- let Chromium handle media loading against the resolved file-backed response

The renderer-facing contract should expose local URLs such as:

```ts
const resolved = {
  url: "media://default/item-123/main-video";
};
```

Not:

```ts
const resolved = {
  path: "/absolute/path/to/file.mp4";
};
```

## Main-process API Sketch

```ts
export interface MediaCacheOptions {
  storageRoot?: string;
  maxCacheBytes?: number;
  reserveFreeBytes?: number;
  staleDeleteAfterMs?: number;
  onSyncFailure?: "serve-last-snapshot" | "throw";
  resolveManifest: () =>
    | Promise<MediaCacheManifest | MediaNamespaceDefinition[] | MediaContentDefinition[]>
    | MediaCacheManifest
    | MediaNamespaceDefinition[]
    | MediaContentDefinition[];
  resolveAssetRequest?: (
    ctx: ResolveAssetRequestContext,
  ) => Promise<DownloadRequest> | DownloadRequest;
}

export interface MediaCacheMain {
  start(): Promise<void>;
  syncNow(): Promise<void>;
  getStatus(): Promise<MediaCacheStatus>;
  registerProtocol(): void;
  attachIpc(): void;
}

export declare function createMediaCache(options: MediaCacheOptions): MediaCacheMain;
```

## Renderer Contract

The renderer should work in terms of content items, not low-level assets.

### Example resolved item shape

```ts
export interface ResolvedMediaContentItem {
  namespace: string;
  id: string;
  version: string;
  kind: MediaKind;
  title?: string;
  description?: string;
  summary?: string;
  blobs: Record<string, string>;
  metadata: Record<string, JsonValue>;
  assets: ResolvedMediaAsset[];
}

export interface ResolvedMediaAsset {
  id: string;
  role: string;
  kind: string;
  mimeType?: string;
  byteLength?: number;
  url: string;
  metadata: Record<string, JsonValue>;
}
```

### React API direction

```ts
useMediaCacheStatus()
useMediaNamespaces()
useMediaItems(namespace?: string)
useMediaItem(namespace: string, id: string)
```

This keeps the consumer focused on rendering content rather than reconstructing local
file relationships manually.

## Storage Policy

Config should support:

- `maxCacheBytes?`
- `reserveFreeBytes?`

Behavior:

- when estimated required bytes exceed policy, raise a distinct storage error
- when actual writes fail with disk-full conditions, raise the same distinct storage
  error family
- then apply configured sync failure behavior

Do not silently evict active content in first release to make room unless that policy is
explicitly added later.

## Search

Search is intentionally deferred from the first release.

However, the schema should leave room for:

- SQLite FTS over titles, descriptions, summaries, and text blobs
- namespace-scoped search
- tag / metadata filtering

This should be designed in, but not built first.

## Open Questions Remaining

These should be settled before a concrete implementation plan:

1. Should the manifest callback receive a context object, such as app version,
   environment, or previous snapshot metadata?
2. Do we want namespace-specific sync in the future, or is every sync always global?
3. Should asset `role` remain freeform string, or should we publish a recommended enum?
4. Should the package expose query APIs beyond lookup-by-id, such as filtering or
   pagination?
5. Should failed downloads for one item fail the whole sync, or can some failures be
   tolerated behind an option later?
6. Do we want to persist historic sync records for diagnostics and support tooling?

## Current Recommendation

Before implementation, lock down:

- the manifest contract in this document
- the exact config surface for failure and storage policy
- the protocol strategy for renderer-safe local URLs
- the SQLite schema around committed generations and pending deletions

Once those are stable, implementation planning becomes straightforward.
