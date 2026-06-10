import { contextBridge, ipcRenderer } from "electron";
import { createBridgeOperationInvokers } from "../shared/bridge-operations.js";
import { MEDIA_CACHE_IPC } from "../shared/ipc.js";
import type { MediaCacheBridge, PreloadExposeOptions } from "../shared/types.js";

/**
 * Builds a {@link import("../shared/types.js").MediaCacheBridge} that invokes main-process handlers via `ipcRenderer`.
 */
export function createMediaCacheBridge(): MediaCacheBridge {
  return {
    ...createBridgeOperationInvokers(ipcRenderer),
    subscribeStatus: (listener) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        status: Awaited<ReturnType<MediaCacheBridge["getStatus"]>>,
      ) => listener(status);
      ipcRenderer.on(MEDIA_CACHE_IPC.statusChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(MEDIA_CACHE_IPC.statusChanged, wrapped);
      };
    },
  };
}

/**
 * Exposes the bridge on the renderer's `window` under `options.key` (default `mediaCache`) using `contextBridge.exposeInMainWorld`.
 */
export function exposeMediaCacheBridge(options?: PreloadExposeOptions): MediaCacheBridge {
  const bridge = createMediaCacheBridge();
  contextBridge.exposeInMainWorld(options?.key ?? "mediaCache", bridge);
  return bridge;
}

export type { MediaCacheBridge } from "../shared/types.js";
