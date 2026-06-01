import { MEDIA_CACHE_IPC } from "./ipc.js";
import type { MediaCacheBridge } from "./types.js";

export type MediaCacheBridgeOperationName =
  | "getStatus"
  | "syncNow"
  | "getAsset"
  | "listByIndex"
  | "findByFileStem";

export interface MediaCacheBridgeOperation<Name extends MediaCacheBridgeOperationName> {
  name: Name;
  channel: (typeof MEDIA_CACHE_IPC)[Name];
}

export const MEDIA_CACHE_BRIDGE_OPERATIONS = {
  getStatus: {
    name: "getStatus",
    channel: MEDIA_CACHE_IPC.getStatus,
  },
  syncNow: {
    name: "syncNow",
    channel: MEDIA_CACHE_IPC.syncNow,
  },
  getAsset: {
    name: "getAsset",
    channel: MEDIA_CACHE_IPC.getAsset,
  },
  listByIndex: {
    name: "listByIndex",
    channel: MEDIA_CACHE_IPC.listByIndex,
  },
  findByFileStem: {
    name: "findByFileStem",
    channel: MEDIA_CACHE_IPC.findByFileStem,
  },
} as const satisfies {
  [Name in MediaCacheBridgeOperationName]: MediaCacheBridgeOperation<Name>;
};

export const MEDIA_CACHE_BRIDGE_OPERATION_LIST = Object.values(
  MEDIA_CACHE_BRIDGE_OPERATIONS,
) as Array<MediaCacheBridgeOperation<MediaCacheBridgeOperationName>>;

export type MediaCacheBridgeOperationHandlers = Pick<
  MediaCacheBridge,
  MediaCacheBridgeOperationName
>;
