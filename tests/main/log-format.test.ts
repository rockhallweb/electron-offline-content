import { describe, expect, it } from "vitest";
import { formatMediaCacheConsoleLine } from "../../src/internal/log-format.js";
import type { MediaCacheLogEvent } from "../../src/shared/types.js";

function entry(overrides: Partial<MediaCacheLogEvent> = {}): MediaCacheLogEvent {
  return {
    timestamp: "2026-03-30T12:00:00.000Z",
    level: "info",
    service: "rockhallweb-electron-offline-content",
    component: "media-cache",
    event: "cache_initialized",
    ...overrides,
  };
}

describe("formatMediaCacheConsoleLine", () => {
  describe("english format — cataloged events", () => {
    it("cache_initialized reads as a sentence with optional details", () => {
      expect(
        formatMediaCacheConsoleLine(
          entry({
            storage_root: "/tmp/cache",
            active_generation_id: 3,
            dev_passthrough_enabled: false,
          }),
          "english",
        ),
      ).toBe("[media-cache] INFO Cache initialized at /tmp/cache (generation #3)");
    });

    it("cache_initialized with passthrough on includes that detail", () => {
      expect(
        formatMediaCacheConsoleLine(
          entry({
            storage_root: "/tmp/cache",
            active_generation_id: null,
            dev_passthrough_enabled: true,
          }),
          "english",
        ),
      ).toBe("[media-cache] INFO Cache initialized at /tmp/cache (dev passthrough on)");
    });

    it("sync_started", () => {
      expect(
        formatMediaCacheConsoleLine(entry({ event: "sync_started", run_id: 5 }), "english"),
      ).toBe("[media-cache] INFO Sync started (run #5)");
    });

    it("sync_completed formats bytes and counts", () => {
      expect(
        formatMediaCacheConsoleLine(
          entry({
            event: "sync_completed",
            run_id: 5,
            active_generation_id: 7,
            total_assets: 12,
            downloaded_assets: 8,
            skipped_assets: 4,
            bytes_downloaded: 1_500_000,
          }),
          "english",
        ),
      ).toBe(
        "[media-cache] INFO Sync complete: 8 downloaded, 4 skipped, 1.4 MB transferred (run #5)",
      );
    });

    it("sync_failed includes error code and message", () => {
      expect(
        formatMediaCacheConsoleLine(
          entry({
            level: "error",
            event: "sync_failed",
            run_id: 2,
            active_generation_id: 1,
            error_code: "STORAGE_LIMIT",
            error_message: "Not enough disk space",
            total_assets: 5,
            downloaded_assets: 2,
            skipped_assets: 0,
            bytes_downloaded: 0,
          }),
          "english",
        ),
      ).toBe("[media-cache] ERROR Sync failed: STORAGE_LIMIT — Not enough disk space (run #2)");
    });

    it("asset_download_started includes version without duplicating prefix", () => {
      expect(
        formatMediaCacheConsoleLine(
          entry({
            level: "debug",
            event: "asset_download_started",
            run_id: 1,
            namespace: "nature",
            item_id: "forest",
            asset_id: "main",
            resolved_version: "v2",
          }),
          "english",
        ),
      ).toBe("[media-cache] DEBUG Downloading nature/forest/main v2");
    });

    it("storage_limit_exceeded formats byte values", () => {
      expect(
        formatMediaCacheConsoleLine(
          entry({
            level: "warn",
            event: "storage_limit_exceeded",
            current_bytes: 500_000_000,
            estimated_download_bytes: 200_000_000,
            max_cache_bytes: 600_000_000,
          }),
          "english",
        ),
      ).toBe(
        "[media-cache] WARN Storage limit exceeded: 476.8 MB on disk + 190.7 MB needed exceeds 572.2 MB limit",
      );
    });

    it("protocol_registered has no trailing details", () => {
      expect(formatMediaCacheConsoleLine(entry({ event: "protocol_registered" }), "english")).toBe(
        "[media-cache] INFO media:// protocol handler registered",
      );
    });

    it("dev_passthrough_active via option", () => {
      expect(
        formatMediaCacheConsoleLine(
          entry({ event: "dev_passthrough_active", source: "option", node_env: "development" }),
          "english",
        ),
      ).toBe("[media-cache] INFO Dev passthrough enabled via config option");
    });

    it("dev_passthrough_active via node_env", () => {
      expect(
        formatMediaCacheConsoleLine(
          entry({ event: "dev_passthrough_active", source: "node_env", node_env: "development" }),
          "english",
        ),
      ).toBe("[media-cache] INFO Dev passthrough enabled via NODE_ENV=development");
    });
  });

  describe("english format — unknown events fall back to generic format", () => {
    it("humanizes the event name and lists fields", () => {
      expect(
        formatMediaCacheConsoleLine(
          entry({ event: "some_future_event", foo: "bar", count: 42 }),
          "english",
        ),
      ).toBe("[media-cache] INFO Some future event (count: 42, foo: bar)");
    });

    it("unknown event with no extra fields omits parenthetical", () => {
      expect(formatMediaCacheConsoleLine(entry({ event: "bare_event" }), "english")).toBe(
        "[media-cache] INFO Bare event",
      );
    });
  });

  describe("json format", () => {
    it("includes full JSON payload after prefix", () => {
      const e = entry({ run_id: 42 });
      const line = formatMediaCacheConsoleLine(e, "json");
      expect(line.startsWith("[media-cache] info cache_initialized ")).toBe(true);
      const jsonPart = line.slice("[media-cache] info cache_initialized ".length);
      expect(JSON.parse(jsonPart)).toEqual(e);
    });
  });
});
