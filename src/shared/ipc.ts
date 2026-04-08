export const MEDIA_CACHE_IPC = {
  getStatus: "rockhallweb:media-cache:get-status",
  syncNow: "rockhallweb:media-cache:sync-now",
  getAsset: "rockhallweb:media-cache:get-asset",
  listByIndex: "rockhallweb:media-cache:list-by-index",
  findByFileStem: "rockhallweb:media-cache:find-by-file-stem",
  statusChanged: "rockhallweb:media-cache:status-changed",
} as const;
