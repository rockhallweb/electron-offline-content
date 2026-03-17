import { contextBridge, ipcRenderer } from 'electron';
import { MEDIA_CACHE_IPC } from '../shared/ipc.js';
import type {
  MediaCacheBridge,
  PaginationInput,
  PreloadExposeOptions,
} from '../shared/types.js';

export function createMediaCacheBridge(): MediaCacheBridge {
  return {
    getStatus: () => ipcRenderer.invoke(MEDIA_CACHE_IPC.getStatus),
    getItem: (namespace, id) => ipcRenderer.invoke(MEDIA_CACHE_IPC.getItem, namespace, id),
    listNamespace: (namespace, pagination?: PaginationInput) =>
      ipcRenderer.invoke(MEDIA_CACHE_IPC.listNamespace, namespace, pagination),
    listNamespaceTree: (prefix, pagination?: PaginationInput) =>
      ipcRenderer.invoke(MEDIA_CACHE_IPC.listNamespaceTree, prefix, pagination),
    findByFileStem: (stem, options) =>
      ipcRenderer.invoke(MEDIA_CACHE_IPC.findByFileStem, stem, options),
    subscribeStatus: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, status: Awaited<ReturnType<MediaCacheBridge['getStatus']>>) =>
        listener(status);
      ipcRenderer.on(MEDIA_CACHE_IPC.statusChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(MEDIA_CACHE_IPC.statusChanged, wrapped);
      };
    },
  };
}

export function exposeMediaCacheBridge(options?: PreloadExposeOptions): MediaCacheBridge {
  const bridge = createMediaCacheBridge();
  contextBridge.exposeInMainWorld(options?.key ?? 'mediaCache', bridge);
  return bridge;
}

export type { MediaCacheBridge } from '../shared/types.js';
