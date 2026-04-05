import { contextBridge, ipcRenderer } from "electron";
import { MEDIA_CACHE_IPC } from "../shared/ipc.js";
import type {
  MediaCacheBridge,
  MediaCacheStatus,
  PaginationInput,
  PreloadExposeOptions,
} from "../shared/types.js";

const statusListeners = new Set<(status: MediaCacheStatus) => void>();

function dispatchStatus(_event: Electron.IpcRendererEvent, status: MediaCacheStatus): void {
  const snapshot = Array.from(statusListeners);
  for (const listener of snapshot) {
    try {
      listener(status);
    } catch (err) {
      console.error("[media-cache] subscribeStatus listener threw:", err);
    }
  }
}

/**
 * Builds a {@link import("../shared/types.js").MediaCacheBridge} that invokes main-process handlers via `ipcRenderer`.
 * Does not call `contextBridge`; use {@link exposeMediaCacheBridge} from an isolated preload to put the API on `window`.
 */
export function createMediaCacheBridge(): MediaCacheBridge {
  return {
    getStatus: () => ipcRenderer.invoke(MEDIA_CACHE_IPC.getStatus),
    syncNow: () => ipcRenderer.invoke(MEDIA_CACHE_IPC.syncNow),
    getItem: (namespace, id) => ipcRenderer.invoke(MEDIA_CACHE_IPC.getItem, namespace, id),
    listNamespace: (namespace, pagination?: PaginationInput) =>
      ipcRenderer.invoke(MEDIA_CACHE_IPC.listNamespace, namespace, pagination),
    listNamespaceTree: (prefix, pagination?: PaginationInput) =>
      ipcRenderer.invoke(MEDIA_CACHE_IPC.listNamespaceTree, prefix, pagination),
    findByFileStem: (stem, options) =>
      ipcRenderer.invoke(MEDIA_CACHE_IPC.findByFileStem, stem, options),
    subscribeStatus: (listener) => {
      statusListeners.add(listener);
      if (statusListeners.size === 1) {
        ipcRenderer.on(MEDIA_CACHE_IPC.statusChanged, dispatchStatus);
      }
      return () => {
        statusListeners.delete(listener);
        if (statusListeners.size === 0) {
          ipcRenderer.removeListener(MEDIA_CACHE_IPC.statusChanged, dispatchStatus);
        }
      };
    },
  };
}

/**
 * Exposes the bridge on the renderer's `window` under `options.key` (default `mediaCache`) using `contextBridge.exposeInMainWorld`.
 * Returns the same bridge instance for convenience.
 */
export function exposeMediaCacheBridge(options?: PreloadExposeOptions): MediaCacheBridge {
  const bridge = createMediaCacheBridge();
  contextBridge.exposeInMainWorld(options?.key ?? "mediaCache", bridge);
  return bridge;
}

export type { MediaCacheBridge } from "../shared/types.js";
