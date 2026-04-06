# @rockhallweb/electron-offline-content — Skill Spec

Electron package for kiosk-style apps that syncs a full manifest of offline
media content (video, images, audio, documents) to disk via SQLite-backed
metadata and blob storage, then serves it through a privileged `media://`
protocol with React hooks for renderer access. Pre-1.0 — breaking changes
are expected.

## Domains

| Domain                       | Description                                                              | Skills                                                       |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Content sync and storage     | Main-process manifest resolution, download pipeline, generation commits  | getting-started, manifest-authoring, authenticated-downloads |
| Renderer access              | Preload bridge, React hooks, status subscriptions, media:// protocol     | react-rendering                                              |
| Configuration and operations | Storage limits, logging, sync failure modes, dev passthrough, deployment | cache-configuration, production-checklist                    |

## Skill Inventory

| Skill                   | Type      | Domain          | What it covers                                                    | Failure modes |
| ----------------------- | --------- | --------------- | ----------------------------------------------------------------- | ------------- |
| getting-started         | lifecycle | content-sync    | Full wiring: main → preload → renderer, first offline render      | 6             |
| manifest-authoring      | core      | content-sync    | resolveManifest, define helpers, namespaces, validation, versions | 7             |
| cache-configuration     | core      | config-ops      | createMediaCache options, storage, passthrough, logging, limits   | 5             |
| react-rendering         | framework | renderer-access | Provider, hooks, AsyncState, error aggregation, media:// URLs     | 5             |
| authenticated-downloads | core      | content-sync    | resolveAssetRequest, signed URLs, bearer tokens, source headers   | 4             |
| production-checklist    | lifecycle | config-ops      | Go-live audit: limits, logging, failure mode, scope boundaries    | 6             |

## Failure Mode Inventory

### getting-started (6 failure modes)

| #   | Mistake                                  | Priority | Source                             | Cross-skill? |
| --- | ---------------------------------------- | -------- | ---------------------------------- | ------------ |
| 1   | Creating cache after app.whenReady()     | CRITICAL | README; media-cache.ts constructor | —            |
| 2   | Missing preload bridge setup             | CRITICAL | react/index.tsx                    | —            |
| 3   | Missing MediaCacheProvider in React tree | HIGH     | react/index.tsx                    | —            |
| 4   | Forgetting app.requestSingleInstanceLock | HIGH     | README; examples/local/src/main.ts | —            |
| 5   | Awaiting mediaCache.start() at launch    | HIGH     | Maintainer interview               | —            |
| 6   | Not realizing start() timing is flexible | MEDIUM   | Maintainer interview               | —            |

### manifest-authoring (7 failure modes)

| #   | Mistake                                        | Priority | Source                       | Cross-skill? |
| --- | ---------------------------------------------- | -------- | ---------------------------- | ------------ |
| 1   | Duplicate keys when mapping to manifest maps   | HIGH     | producer.ts \*FromEntries    | —            |
| 2   | Omitting required item version                 | HIGH     | normalize.ts; validation.ts  | —            |
| 3   | Asset URL without filename in path             | HIGH     | internal/asset-file-name.ts  | —            |
| 4   | Deep nesting instead of defineItem/defineAsset | HIGH     | Maintainer interview; README | —            |
| 5   | Using non-HTTP asset source URLs               | MEDIUM   | validation.ts                | —            |
| 6   | Duplicate item keys within namespace           | MEDIUM   | producer.ts itemsFromEntries | —            |
| 7   | Over-namespacing with too many namespaces      | MEDIUM   | Maintainer interview         | —            |

### cache-configuration (5 failure modes)

| #   | Mistake                                     | Priority | Source                               | Cross-skill? |
| --- | ------------------------------------------- | -------- | ------------------------------------ | ------------ |
| 1   | Setting assetBaseUrl without devPassthrough | HIGH     | media-cache.ts constructor           | —            |
| 2   | Arbitrary file paths for storagePath        | HIGH     | types.ts; validation.ts              | —            |
| 3   | Two cache instances on same storage root    | HIGH     | storage-root-lock.ts                 | —            |
| 4   | assetBaseUrl with path or query string      | MEDIUM   | media-cache.ts normalizeAssetBaseUrl | —            |
| 5   | Path separators in storagePath segments     | MEDIUM   | validation.ts                        | —            |

### react-rendering (5 failure modes)

| #   | Mistake                                              | Priority | Source                     | Cross-skill? |
| --- | ---------------------------------------------------- | -------- | -------------------------- | ------------ |
| 1   | Accessing data before loading completes              | HIGH     | react/index.tsx            | —            |
| 2   | Fetching remote URLs instead of rendering direct     | HIGH     | Maintainer interview       | —            |
| 3   | Using removed useMediaNamespace hooks (use useMedia) | HIGH     | CHANGELOG; react/index.tsx | —            |
| 4   | Multiple independent status subscriptions            | MEDIUM   | react/index.tsx            | —            |
| 5   | Hardcoding media:// URLs instead of using hooks      | MEDIUM   | database.ts; README        | —            |

### authenticated-downloads (4 failure modes)

| #   | Mistake                                                | Priority | Source               | Cross-skill?                                 |
| --- | ------------------------------------------------------ | -------- | -------------------- | -------------------------------------------- |
| 1   | Expecting resolveAssetRequest in devPassthrough        | HIGH     | README               | authenticated-downloads, cache-configuration |
| 2   | Pre-signed URL expiration too short for catalog sync   | HIGH     | Maintainer interview | —                                            |
| 3   | Confusing resolveAssetRequest with resolveManifest     | MEDIUM   | types.ts; README     | —                                            |
| 4   | Using resolveAssetRequest for long-lived static tokens | MEDIUM   | README               | —                                            |

### production-checklist (6 failure modes)

| #   | Mistake                                        | Priority | Source                   | Cross-skill?                              |
| --- | ---------------------------------------------- | -------- | ------------------------ | ----------------------------------------- |
| 1   | devPassthrough left enabled in production      | CRITICAL | media-cache.ts; types.ts | production-checklist, cache-configuration |
| 2   | Shipping with only dev passthrough testing     | CRITICAL | Maintainer interview     | —                                         |
| 3   | No storage limits on limited disk              | HIGH     | README                   | —                                         |
| 4   | Switching to offline without considering space | HIGH     | Maintainer interview     | —                                         |
| 5   | Default console logging in production          | MEDIUM   | media-cache.ts; README   | —                                         |
| 6   | Using package for user-generated content       | MEDIUM   | Maintainer interview     | —                                         |

## Tensions

| Tension                                              | Skills                                       | Agent implication                                                                        |
| ---------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Dev passthrough simplicity vs production correctness | cache-configuration ↔ production-checklist   | Agent generates code working in dev but broken in production (auth, failure modes, URLs) |
| Manifest flexibility vs validation strictness        | manifest-authoring ↔ getting-started         | Agent uses flexible shorthand but forgets required fields or produces duplicate keys     |
| Sync resilience vs stale content                     | cache-configuration ↔ production-checklist   | Agent picks serve-last-snapshot without considering silently stale content may be worse  |
| Manifest-time auth vs download-time auth             | authenticated-downloads ↔ manifest-authoring | Agent must evaluate catalog size and sync duration to choose signing strategy            |

## Cross-References

| From                    | To                   | Reason                                                          |
| ----------------------- | -------------------- | --------------------------------------------------------------- |
| getting-started         | manifest-authoring   | Manifest is the first thing to write                            |
| getting-started         | cache-configuration  | createMediaCache options are part of initial setup              |
| cache-configuration     | production-checklist | Production config is a subset of cache configuration            |
| react-rendering         | getting-started      | Rendering requires full main → preload → renderer wiring        |
| authenticated-downloads | manifest-authoring   | Auth can be manifest-time (headers) or download-time (callback) |
| authenticated-downloads | cache-configuration  | resolveAssetRequest is ignored in dev passthrough               |
| production-checklist    | cache-configuration  | Checklist items are configuration changes                       |
| manifest-authoring      | react-rendering      | Namespace organization determines how hooks query content       |

## Subsystems & Reference Candidates

| Skill                   | Subsystems | Reference candidates                            |
| ----------------------- | ---------- | ----------------------------------------------- |
| getting-started         | —          | —                                               |
| manifest-authoring      | —          | MediaKind values, validation rules              |
| cache-configuration     | —          | MediaCacheOptions field reference (>10 options) |
| react-rendering         | —          | Hook API signatures (7 hooks)                   |
| authenticated-downloads | —          | —                                               |
| production-checklist    | —          | —                                               |

## Remaining Gaps

| Skill                   | Question                                                                           | Status                    |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| getting-started         | How should agents handle the kiosk reboot lifecycle?                               | open                      |
| react-rendering         | How should errors be surfaced in a kiosk with no user interaction?                 | open                      |
| manifest-authoring      | Recommended pattern for S3-compatible bucket integration?                          | resolved-in-failure-modes |
| cache-configuration     | What happens when the manifest grows very large (thousands of items)?              | open                      |
| authenticated-downloads | Optional manifest-level expiration timestamp for fail-fast on expired signed URLs? | filed-as-issue (#9)       |

## Recommended Skill File Structure

- **Core skills:** manifest-authoring, cache-configuration, authenticated-downloads
- **Framework skills:** react-rendering
- **Lifecycle skills:** getting-started, production-checklist
- **Composition skills:** (none yet — S3-compatible bucket integration is a candidate)
- **Reference files:** cache-configuration (>10 config options), react-rendering (7 hooks)

## Composition Opportunities

| Library  | Integration points                       | Composition skill needed?             |
| -------- | ---------------------------------------- | ------------------------------------- |
| React    | Hooks, context provider, rendering       | No — core framework                   |
| Electron | app lifecycle, session, protocol, IPC    | No — required peer dep                |
| S3 SDK   | resolveManifest fetching object listings | Potentially (per maintainer interest) |
