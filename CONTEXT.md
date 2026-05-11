# Context

## Glossary

**Manifest** — Authoritative content snapshot returned by `resolveManifest`. A manifest describes namespaces, items, and downloadable assets for one sync.

**Generation** — Staged or committed SQLite and blob-storage snapshot derived from a manifest. A committed generation is the catalog currently served to renderers.

**Asset Download** — One asset transfer from a resolved download request to a committed blob, including partial resume, retry handling, and atomic commit.

**Partial Download** — Resumable `.part` file under the cache temp tree. Partial downloads can survive retryable failures and reduce later download-byte estimates.

**Blob** — Committed on-disk asset file served through resolved catalog URLs.
