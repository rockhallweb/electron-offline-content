import type { JsonValue, MediaCacheLogEvent, MediaCacheLogFormat } from "../shared/types.js";

const RESERVED_ENTRY_KEYS = new Set(["timestamp", "level", "event", "service", "component"]);

function str(v: JsonValue | undefined): string {
  if (v === undefined || v === null) return "unknown";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function assetPath(e: MediaCacheLogEvent): string {
  return `${str(e.namespace)}/${str(e.item_id)}/${str(e.asset_id)}`;
}

function formatBytes(v: JsonValue | undefined): string {
  if (typeof v !== "number") return str(v);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

type MessageFn = (e: MediaCacheLogEvent) => string;

const EVENT_MESSAGES: Record<string, MessageFn> = {
  dev_passthrough_active: (e) =>
    e.source === "option"
      ? "Dev passthrough enabled via config option"
      : `Dev passthrough enabled via NODE_ENV=${str(e.node_env)}`,

  dev_passthrough_ignores_sync_failure_mode: (e) =>
    `Dev passthrough ignores onSyncFailure "${str(e.configured_mode)}" — failures always throw in passthrough mode`,

  dev_passthrough_clearing_state: (e) =>
    `Clearing local state at ${str(e.storage_root)} (dev passthrough resets on startup)`,

  cache_storage_location: (e) => `Storage location: ${str(e.storage_root)}`,

  cache_initialized: (e) => {
    const parts: string[] = [];
    if (e.active_generation_id != null) {
      parts.push(`generation #${str(e.active_generation_id)}`);
    }
    if (e.dev_passthrough_enabled === true) {
      parts.push("dev passthrough on");
    }
    const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    return `Cache initialized at ${str(e.storage_root)}${suffix}`;
  },

  protocol_registered: () => "media:// protocol handler registered",

  protocol_registration_skipped: (e) => `Protocol registration skipped: ${str(e.reason)}`,

  protocol_request_not_found: (e) => `media:// request not found: ${assetPath(e)}`,

  protocol_request_file_missing: (e) => `media:// asset file missing on disk: ${assetPath(e)}`,

  protocol_request_local_resolved: (e) => {
    const range = e.range ? ` range ${str(e.range)}` : "";
    return `media:// serving ${assetPath(e)}${range}`;
  },

  ipc_attached: () => "IPC handlers attached",
  ipc_attach_skipped: (e) => `IPC attach skipped: ${str(e.reason)}`,

  resolve_asset_base_url_fallback: (e) =>
    `Could not rewrite asset URL for ${str(e.context_label)}: ${str(e.error)}`,

  status_snapshot_invalid: (e) =>
    `Stored status snapshot is invalid (${str(e.error_code)}: ${str(e.error_message)}), starting fresh`,

  sync_reused: (e) =>
    `Sync already in progress (phase: ${str(e.phase)}, generation #${str(e.active_generation_id)})`,

  sync_started: (e) => `Sync started (run #${str(e.run_id)})`,

  manifest_resolved: (e) =>
    `Manifest resolved: ${str(e.namespace_count)} namespace(s), ${str(e.item_count)} item(s) → generation #${str(e.staged_generation_id)} (run #${str(e.run_id)})`,

  sync_diffed: (e) =>
    `Diff complete: ${str(e.total_assets)} asset(s) total, ${str(e.download_count)} to download, ${str(e.skipped_assets)} already cached (run #${str(e.run_id)})`,

  asset_download_started: (e) => `Downloading ${assetPath(e)} ${str(e.resolved_version)}`,

  asset_download_completed: (e) => `Downloaded ${assetPath(e)} → ${str(e.relative_path)}`,

  asset_download_range_restart: (e) =>
    `Server does not support range resume for ${assetPath(e)} (HTTP ${str(e.response_status)}), restarting full download`,

  asset_download_rejected: (e) =>
    `Download rejected for ${assetPath(e)}: HTTP ${str(e.status)} ${str(e.status_text)}`,

  asset_download_retry_scheduled: (e) =>
    `Retrying ${assetPath(e)} in ${str(e.retry_delay_ms)}ms (attempt ${str(e.attempt)})`,

  asset_download_retry_exhausted: (e) =>
    `Giving up on ${assetPath(e)} after ${str(e.attempt)} attempt(s)`,

  asset_download_storage_failed: (e) => `Disk write failed for ${assetPath(e)} from ${str(e.url)}`,

  generation_committed: (e) =>
    `Generation #${str(e.active_generation_id)} committed, replacing #${str(e.previous_generation_id)} (run #${str(e.run_id)})`,

  sync_completed: (e) =>
    `Sync complete: ${str(e.downloaded_assets)} downloaded, ${str(e.skipped_assets)} skipped, ${formatBytes(e.bytes_downloaded)} transferred (run #${str(e.run_id)})`,

  sync_failed: (e) =>
    `Sync failed: ${str(e.error_code)} — ${str(e.error_message)} (run #${str(e.run_id)})`,

  storage_limit_exceeded: (e) =>
    `Storage limit exceeded: ${formatBytes(e.current_bytes)} on disk + ${formatBytes(e.estimated_download_bytes)} needed exceeds ${formatBytes(e.max_cache_bytes)} limit`,

  storage_reserve_violation: (e) =>
    `Not enough free disk space: ${formatBytes(e.available_bytes)} available, need ${formatBytes(e.estimated_download_bytes)} with ${formatBytes(e.reserve_free_bytes)} reserved`,

  assets_marked_for_deletion: (e) =>
    `Marked ${str(e.marked_count)} asset(s) from generation #${str(e.previous_generation_id)} for deletion`,

  deletion_prune_skipped: () => "No expired assets to prune",

  assets_pruned: (e) => `Pruned ${str(e.pruned_count)} expired asset(s) from disk`,
};

function formatEnglishLine(entry: MediaCacheLogEvent): string {
  const messageFn = EVENT_MESSAGES[entry.event];
  if (messageFn) {
    return `[${entry.component}] ${entry.level.toUpperCase()} ${messageFn(entry)}`;
  }
  return formatGenericEnglishLine(entry);
}

function formatGenericEnglishLine(entry: MediaCacheLogEvent): string {
  const label = entry.event
    .replace(/[._]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
  const keys = Object.keys(entry).filter((k) => !RESERVED_ENTRY_KEYS.has(k));
  keys.sort();
  const details = keys
    .map((key) => {
      const v = entry[key];
      if (v === undefined) return null;
      const humanKey = key
        .replace(/[._]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase();
      return `${humanKey}: ${str(v)}`;
    })
    .filter((s): s is string => s != null);
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `[${entry.component}] ${entry.level.toUpperCase()} ${label}${suffix}`;
}

/**
 * Single line for the default development console sink.
 */
export function formatMediaCacheConsoleLine(
  entry: MediaCacheLogEvent,
  format: MediaCacheLogFormat,
): string {
  if (format === "json") {
    return `[${entry.component}] ${entry.level} ${entry.event} ${JSON.stringify(entry)}`;
  }
  return formatEnglishLine(entry);
}
