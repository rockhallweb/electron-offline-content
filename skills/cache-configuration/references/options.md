# MediaCacheOptions Reference

Complete field-by-field reference for `createMediaCache(options)`.

```typescript
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";
```

---

## storagePath

|              |                         |
| ------------ | ----------------------- |
| **Type**     | `MediaCacheStoragePath` |
| **Required** | Yes                     |
| **Default**  | —                       |

Root directory for cached assets, metadata database, and lock file. Built from an Electron `app.getPath` name plus optional subdirectory segments.

**Constraints:** `appPath` must be a valid `MediaCacheAppPath` value. `segments`, if provided, must not contain `"/"` or `"\\"` characters.

```typescript
storagePath: { appPath: "userData", segments: ["my-app", "offline-media"] }
```

### MediaCacheStoragePath

```typescript
interface MediaCacheStoragePath {
  appPath: MediaCacheAppPath;
  segments?: string[];
}
```

### MediaCacheAppPath

Union of Electron `app.getPath` names:

| Value           | Electron path                                                             |
| --------------- | ------------------------------------------------------------------------- |
| `"home"`        | User home directory                                                       |
| `"appData"`     | Per-user application data (`%APPDATA%` / `~/Library/Application Support`) |
| `"userData"`    | `appData` + app name                                                      |
| `"sessionData"` | Session-specific data                                                     |
| `"temp"`        | Temporary directory                                                       |
| `"exe"`         | Executable path                                                           |
| `"module"`      | `libchromiumcontent` library                                              |
| `"desktop"`     | Desktop directory                                                         |
| `"documents"`   | Documents directory                                                       |
| `"downloads"`   | Downloads directory                                                       |
| `"music"`       | Music directory                                                           |
| `"pictures"`    | Pictures directory                                                        |
| `"videos"`      | Videos directory                                                          |
| `"recent"`      | Recent files directory                                                    |
| `"logs"`        | Log files directory                                                       |
| `"crashDumps"`  | Crash dumps directory                                                     |

---

## devPassthrough

|              |                                                             |
| ------------ | ----------------------------------------------------------- |
| **Type**     | `boolean`                                                   |
| **Required** | No                                                          |
| **Default**  | `true` when `NODE_ENV === "development"`, `false` otherwise |

Skips all downloads and serves remote URLs directly. Intended for development only.

**Constraints:** When `true`, `resolveAssetRequest` is never called, `onSyncFailure` is overridden to `"throw"`, and hook URLs return remote `https://` URLs instead of `media://`.

```typescript
devPassthrough: true;
```

---

## assetBaseUrl

|              |                  |
| ------------ | ---------------- |
| **Type**     | `string \| null` |
| **Required** | No               |
| **Default**  | `null`           |

Origin override for asset URLs in dev passthrough mode. Replaces the origin of all asset source URLs.

**Constraints:** Must be an origin only (protocol + hostname + optional port). Must not include path, query, hash, or credentials. Requires `devPassthrough: true` — constructor throws if set while `devPassthrough` is `false`.

```typescript
assetBaseUrl: "http://localhost:3000";
```

---

## maxCacheBytes

|              |           |
| ------------ | --------- |
| **Type**     | `number`  |
| **Required** | No        |
| **Default**  | Unlimited |

Soft cap on total cache size in bytes. The sync pipeline skips new downloads when the cache exceeds this limit.

**Constraints:** Must be a positive integer when provided.

```typescript
maxCacheBytes: 10 * 1024 * 1024 * 1024; // 10 GB
```

---

## reserveFreeBytes

|              |                            |
| ------------ | -------------------------- |
| **Type**     | `number`                   |
| **Required** | No                         |
| **Default**  | `1073741824` (1 GiB, `1024³` bytes) |

Minimum free disk space to preserve in bytes on the volume that holds the cache. Sync refuses work when projected free space would drop below this value. **`0`** disables the reservation (legacy behavior when the option was omitted).

**Constraints:** Must be a non-negative integer when provided. Omit the option to use the default; set **`0`** explicitly to allow filling the volume up to other limits.

```typescript
reserveFreeBytes: 1 * 1024 * 1024 * 1024; // 1 GB
```

---

## staleDeleteAfterMs

|              |                      |
| ------------ | -------------------- |
| **Type**     | `number`             |
| **Required** | No                   |
| **Default**  | `604800000` (7 days) |

Milliseconds to retain assets that are no longer present in the manifest before deleting them from disk.

**Constraints:** Must be a non-negative integer when provided.

```typescript
staleDeleteAfterMs: 7 * 24 * 60 * 60 * 1000; // 7 days
```

---

## onSyncFailure

|              |                                    |
| ------------ | ---------------------------------- |
| **Type**     | `"serve-last-snapshot" \| "throw"` |
| **Required** | No                                 |
| **Default**  | `"serve-last-snapshot"`            |

Behavior when a sync fails.

- `"serve-last-snapshot"` — continue serving the most recently committed manifest generation. Safe for kiosks (prevents blank screens) but may serve stale content.
- `"throw"` — propagate the sync error. Honest, but can leave the UI empty if no prior generation exists.

**Constraints:** Overridden to `"throw"` when `devPassthrough` is `true`.

```typescript
onSyncFailure: "serve-last-snapshot";
```

---

## syncHistoryLimit

|              |                              |
| ------------ | ---------------------------- |
| **Type**     | `number`                     |
| **Required** | No                           |
| **Default**  | Package default (see source) |

Maximum number of sync generation records retained in the metadata database. Older generations are pruned after successful commits.

**Constraints:** Must be a positive integer when provided.

```typescript
syncHistoryLimit: 5;
```

---

## logging

|              |                                    |
| ------------ | ---------------------------------- |
| **Type**     | `MediaCacheLoggingOptions`         |
| **Required** | No                                 |
| **Default**  | Built-in console sink when omitted |

Nested logging configuration for either the built-in console sink or a custom structured logger.

**Constraints:** `format` cannot be combined with `onLog` in the same object. Use `format` only for the built-in console sink.

```typescript
logging: {
  level: "info",
  onLog: (entry) => {
    logger.info(entry, entry.event);
  },
};
```

---

### MediaCacheLoggingOptions

```typescript
type MediaCacheLoggingOptions =
  | MediaCacheCustomLoggingOptions
  | {
      level?: "debug" | "info" | "warn" | "error";
      format?: never;
      onLog: (entry: MediaCacheLogEvent) => void;
    }
  | {
      level?: "debug" | "info" | "warn" | "error";
      format?: "english" | "json";
      onLog?: undefined;
    };
```

`MediaCacheLoggingOptions` is a discriminated union. The custom-sink branch is represented by `MediaCacheCustomLoggingOptions` in `types.ts`, and TypeScript rejects `format` when `onLog` is present because that branch uses `format?: never`.

### `logging.level`

|              |                                                      |
| ------------ | ---------------------------------------------------- |
| **Type**     | `"debug" \| "info" \| "warn" \| "error"`             |
| **Required** | No                                                   |
| **Default**  | `"debug"` (console sink) / `"info"` (custom `onLog`) |

Minimum log level emitted. Events below this level are discarded.

**Constraints:** None.

```typescript
logging: {
  level: "info";
}
```

### `logging.format`

|              |                       |
| ------------ | --------------------- |
| **Type**     | `"english" \| "json"` |
| **Required** | No                    |
| **Default**  | `"english"`           |

Format for the built-in console sink. `"english"` produces human-readable lines. `"json"` produces one JSON object per line.

**Constraints:** Invalid when `logging.onLog` is provided.

```typescript
logging: {
  format: "json";
}
```

### `logging.onLog`

|              |                                                                   |
| ------------ | ----------------------------------------------------------------- |
| **Type**     | `(entry: MediaCacheLogEvent) => void`                             |
| **Required** | No                                                                |
| **Default**  | Built-in console sink (disabled when `NODE_ENV === "production"`) |

Custom log handler. Receives structured `MediaCacheLogEvent` objects for every log emission. When provided, the built-in console sink is disabled.

**Constraints:** The handler is called synchronously on the main thread. Cannot be combined with `logging.format`.

```typescript
logging: {
  onLog: (entry) => {
    logger.info(entry, entry.event);
  },
};
```

### MediaCacheLogEvent

```typescript
interface MediaCacheLogEvent {
  [key: string]: JsonValue | undefined;
  timestamp: string; // ISO 8601
  level: MediaCacheLogLevel; // "debug" | "info" | "warn" | "error"
  event: string; // e.g. "sync.asset.downloaded", "protocol.request.served"
  service: string; // package identifier
  component: string; // e.g. "sync", "protocol", "database"
}
```

Additional context-specific keys vary by event (e.g. `assetId`, `namespace`, `bytesDownloaded`, `durationMs`). All values are JSON-serializable.

### Migration

Flat logging options were removed in `0.2.0`.

```typescript
// Before
createMediaCache({
  logLevel: "info",
  onLog: (entry) => logger.info(entry, entry.event),
  resolveManifest,
});

// After
createMediaCache({
  logging: {
    level: "info",
    onLog: (entry) => logger.info(entry, entry.event),
  },
  resolveManifest,
});
```

---

## resolveManifest

|              |                                                           |
| ------------ | --------------------------------------------------------- |
| **Type**     | `() => Promise<MediaCacheManifest> \| MediaCacheManifest` |
| **Required** | Yes                                                       |
| **Default**  | —                                                         |

Function called at the start of each sync cycle to produce the current manifest. May be async. The return value is normalized and validated before the download pipeline begins.

**Constraints:** Must return a valid `MediaCacheManifest`. See manifest-authoring/SKILL.md for structure and validation rules.

```typescript
resolveManifest: async () => {
  const res = await fetch("https://cms.example.com/api/content");
  return res.json();
};
```

---

## resolveAssetRequest

|              |                                                                                    |
| ------------ | ---------------------------------------------------------------------------------- |
| **Type**     | `(ctx: ResolveAssetRequestContext) => Promise<DownloadRequest> \| DownloadRequest` |
| **Required** | No                                                                                 |
| **Default**  | Direct download from asset source URL                                              |

Per-asset callback invoked before each download. Use to add authentication headers, generate signed URLs, or transform the download request.

**Constraints:** Never called when `devPassthrough` is `true`. See authenticated-downloads/SKILL.md for usage patterns.

```typescript
resolveAssetRequest: async (ctx) => ({
  url: await getSignedUrl(ctx.asset.source.url),
  headers: { Authorization: `Bearer ${await getToken()}` },
});
```
