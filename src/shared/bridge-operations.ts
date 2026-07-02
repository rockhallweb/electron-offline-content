import { MEDIA_CACHE_IPC } from "./ipc.js";
import type { MediaCacheBridge } from "./types.js";

/**
 * Bridge methods routed through `ipcMain.handle` / `ipcRenderer.invoke`.
 *
 * `subscribeStatus` stays outside the registry: it rides the push-style
 * `statusChanged` event channel rather than an invoke round trip.
 */
export type BridgeOperationName =
  | "getStatus"
  | "syncNow"
  | "getAsset"
  | "listByIndex"
  | "findByFileStem";

/** One invoke-style bridge operation: the bridge method name plus its IPC channel. */
interface BridgeOperationDefinition<Name extends BridgeOperationName = BridgeOperationName> {
  readonly name: Name;
  readonly channel: (typeof MEDIA_CACHE_IPC)[Name];
}

/**
 * Shared bridge operation registry: the single definition of operation names
 * and IPC channels consumed by the main IPC adapter, the preload bridge
 * adapter, and renderer bridge validation.
 */
export const BRIDGE_OPERATIONS = {
  getStatus: { name: "getStatus", channel: MEDIA_CACHE_IPC.getStatus },
  syncNow: { name: "syncNow", channel: MEDIA_CACHE_IPC.syncNow },
  getAsset: { name: "getAsset", channel: MEDIA_CACHE_IPC.getAsset },
  listByIndex: { name: "listByIndex", channel: MEDIA_CACHE_IPC.listByIndex },
  findByFileStem: { name: "findByFileStem", channel: MEDIA_CACHE_IPC.findByFileStem },
} as const satisfies { readonly [Name in BridgeOperationName]: BridgeOperationDefinition<Name> };

export const BRIDGE_OPERATION_NAMES = Object.keys(
  BRIDGE_OPERATIONS,
) as readonly BridgeOperationName[];

/** Bridge methods backed by registry operations, keyed by operation name. */
export type BridgeOperationHandlers = Pick<MediaCacheBridge, BridgeOperationName>;

/** Structural subset of Electron's `IpcMain` used by registry registration. */
export interface BridgeOperationIpcMain {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>): void;
}

/** Registers one `ipcMain.handle` listener per registry operation. */
export function registerBridgeOperationHandlers(
  ipcMain: BridgeOperationIpcMain,
  handlers: BridgeOperationHandlers,
): void {
  for (const name of BRIDGE_OPERATION_NAMES) {
    const handler = handlers[name] as (...args: unknown[]) => Promise<unknown>;
    ipcMain.handle(BRIDGE_OPERATIONS[name].channel, async (_event, ...args) => handler(...args));
  }
}

/** Structural subset of Electron's `ipcRenderer` used by registry invokers. */
export interface BridgeOperationIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/** Builds the invoke-backed bridge methods for registry operations. */
export function createBridgeOperationInvokers(
  ipcRenderer: BridgeOperationIpcRenderer,
): BridgeOperationHandlers {
  const invokers = {} as Record<BridgeOperationName, (...args: unknown[]) => Promise<unknown>>;
  for (const name of BRIDGE_OPERATION_NAMES) {
    const { channel } = BRIDGE_OPERATIONS[name];
    invokers[name] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
  }
  return invokers as BridgeOperationHandlers;
}

/** `true` when `bridge` exposes a callable method for every registry operation. */
export function hasBridgeOperations(bridge: unknown): boolean {
  if (typeof bridge !== "object" || bridge === null) {
    return false;
  }
  const candidate = bridge as Partial<Record<BridgeOperationName, unknown>>;
  return BRIDGE_OPERATION_NAMES.every((name) => typeof candidate[name] === "function");
}
