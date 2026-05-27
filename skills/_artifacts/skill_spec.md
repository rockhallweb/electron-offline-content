# @rockhall/electron-offline-content — Skill Spec

Electron package for kiosk-style apps that syncs a flat asset store of offline media content to disk via SQLite-backed metadata and blob storage, then serves it through a privileged `media://` protocol and a framework-agnostic renderer bridge. Pre-1.0 — breaking changes are expected.

## Domains

| Domain                       | Description                                                              | Skills                                    |
| ---------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| Content sync and storage     | Main-process store resolution, download pipeline, generation commits     | getting-started, store-authoring          |
| Renderer access              | Preload bridge, renderer client, status subscriptions, media:// protocol | getting-started                           |
| Configuration and operations | Storage limits, logging, sync failure modes, dev passthrough, deployment | cache-configuration, production-checklist |

## Skill Inventory

| Skill                   | Type      | Domain       | What it covers                                                     | Failure modes |
| ----------------------- | --------- | ------------ | ------------------------------------------------------------------ | ------------- |
| getting-started         | lifecycle | content-sync | Full wiring: main → preload → renderer, first offline render       | 5             |
| store-authoring         | core      | content-sync | resolveStore, createMediaStore, defineIndex, store.add, validation | 7             |
| cache-configuration     | core      | config-ops   | createMediaCache options, storage, passthrough, logging, limits    | 5             |
| authenticated-downloads | core      | content-sync | Presigned URLs and auth material embedded in asset URLs            | 3             |
| production-checklist    | lifecycle | config-ops   | Go-live audit: limits, logging, failure mode, scope boundaries     | 6             |

## Tensions

| Tension                                              | Skills                                     | Agent implication                                                                        |
| ---------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Dev passthrough simplicity vs production correctness | cache-configuration ↔ production-checklist | Agent generates code working in dev but broken in production (auth, failure modes, URLs) |
| Store flexibility vs validation strictness           | store-authoring ↔ getting-started          | Agent uses flexible shorthand but forgets required fields or produces duplicate keys     |
| Sync resilience vs stale content                     | cache-configuration ↔ production-checklist | Agent picks serve-last-snapshot without considering silently stale content may be worse  |
| App-owned renderer lifecycle vs package convenience  | getting-started                            | Agent must use the renderer client directly or build app-local framework adapters        |

## Cross-References

| From                 | To                      | Reason                                               |
| -------------------- | ----------------------- | ---------------------------------------------------- |
| getting-started      | store-authoring         | Store is the first thing to write                    |
| getting-started      | cache-configuration     | createMediaCache options are part of initial setup   |
| store-authoring      | authenticated-downloads | Presigned URLs are assigned while building the store |
| cache-configuration  | production-checklist    | Production config is a subset of cache configuration |
| production-checklist | cache-configuration     | Checklist items are configuration changes            |

## Recommended Skill File Structure

- **Core skills:** store-authoring, cache-configuration, authenticated-downloads
- **Lifecycle skills:** getting-started, production-checklist
- **Framework skills:** none; renderer framework lifecycle belongs to consuming apps
