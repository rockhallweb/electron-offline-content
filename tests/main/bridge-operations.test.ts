import { describe, expect, it, vi } from "vitest";
import {
  MEDIA_CACHE_BRIDGE_OPERATION_LIST,
  MEDIA_CACHE_BRIDGE_OPERATIONS,
  type MediaCacheBridgeOperationName,
} from "../../src/shared/bridge-operations.js";
import { MEDIA_CACHE_IPC } from "../../src/shared/ipc.js";
import { resolveMediaCacheBridge } from "../../src/renderer/runtime.js";
import { createMediaCache } from "./helpers/media-cache-test-shared.js";
import { createIpcHandlers, createStorageRoot } from "./helpers/media-cache-test-shared.js";
import { buildTestStore } from "./helpers/media-cache-test-shared.js";
import { createBridge } from "../renderer/helpers/media-cache-fixtures.js";

const electronMock = vi.hoisted(() => ({
  contextBridge: {
    exposeInMainWorld: vi.fn<(key: string, api: unknown) => void>(),
  },
  ipcRenderer: {
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
    on: vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>(),
    removeListener: vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>(),
  },
}));

vi.mock("electron", () => electronMock);

describe("MEDIA_CACHE_BRIDGE_OPERATIONS", () => {
  it("defines status and sync channels in one registry", () => {
    expect(MEDIA_CACHE_BRIDGE_OPERATION_LIST).toEqual([
      MEDIA_CACHE_BRIDGE_OPERATIONS.getStatus,
      MEDIA_CACHE_BRIDGE_OPERATIONS.syncNow,
    ]);
    expect(MEDIA_CACHE_BRIDGE_OPERATIONS.getStatus.channel).toBe(MEDIA_CACHE_IPC.getStatus);
    expect(MEDIA_CACHE_BRIDGE_OPERATIONS.syncNow.channel).toBe(MEDIA_CACHE_IPC.syncNow);
  });

  it("registers main IPC handlers for every registry operation", async () => {
    const cache = createMediaCache({
      storageRoot: createStorageRoot(),
      resolveStore: () => buildTestStore({ assets: [] }),
    });

    const handlers = await createIpcHandlers(cache);

    for (const operation of MEDIA_CACHE_BRIDGE_OPERATION_LIST) {
      expect(handlers.get(operation.channel)).toBeTypeOf("function");
    }
  });

  it("uses registry channels for preload status and sync invocations", async () => {
    const { createMediaCacheBridge } = await import("../../src/preload/index.js");
    electronMock.ipcRenderer.invoke.mockResolvedValue(undefined);

    const bridge = createMediaCacheBridge();
    await bridge.getStatus();
    await bridge.syncNow();

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      MEDIA_CACHE_BRIDGE_OPERATIONS.getStatus.channel,
    );
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(
      MEDIA_CACHE_BRIDGE_OPERATIONS.syncNow.channel,
    );
  });

  it("validates renderer bridge methods from the registry", () => {
    for (const operation of MEDIA_CACHE_BRIDGE_OPERATION_LIST) {
      const bridge = createBridge({
        [operation.name]: undefined,
      } as Partial<Record<MediaCacheBridgeOperationName, undefined>>);

      expect(() => resolveMediaCacheBridge({ bridge })).toThrow("MediaCache bridge is unavailable");
    }
  });
});
