import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_OPERATION_NAMES,
  BRIDGE_OPERATIONS,
  createBridgeOperationInvokers,
  hasBridgeOperations,
  registerBridgeOperationHandlers,
  type BridgeOperationHandlers,
  type BridgeOperationIpcMain,
  type BridgeOperationIpcRenderer,
} from "../../src/shared/bridge-operations.js";
import { MEDIA_CACHE_IPC } from "../../src/shared/ipc.js";
import type { MediaCacheStatus } from "../../src/shared/types.js";

function buildStatus(): MediaCacheStatus {
  return {
    phase: "idle",
    storageRoot: "/tmp/media-cache",
    activeGenerationId: null,
    progress: null,
    lastRun: null,
    error: null,
    updatedAt: Date.now(),
  };
}

function buildHandlers(overrides: Partial<BridgeOperationHandlers> = {}): BridgeOperationHandlers {
  return {
    getStatus: async () => buildStatus(),
    syncNow: async () => undefined,
    getAsset: async () => null,
    listByIndex: async () => ({ items: [], nextCursor: null }),
    findByFileStem: async () => ({ items: [], nextCursor: null }),
    ...overrides,
  };
}

/** In-memory invoke bus standing in for the `ipcMain`/`ipcRenderer` pair. */
function createInvokeBus(): {
  ipcMain: BridgeOperationIpcMain;
  ipcRenderer: BridgeOperationIpcRenderer;
  channels: Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>;
} {
  const channels = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  return {
    channels,
    ipcMain: {
      handle: (channel, listener) => {
        channels.set(channel, listener);
      },
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        const listener = channels.get(channel);
        if (!listener) {
          return Promise.reject(new Error(`No handler registered for '${channel}'`));
        }
        return listener({}, ...args);
      },
    },
  };
}

describe("bridge operation registry", () => {
  it("defines each operation's name and IPC channel in one place", () => {
    for (const name of BRIDGE_OPERATION_NAMES) {
      expect(BRIDGE_OPERATIONS[name].name).toBe(name);
      expect(BRIDGE_OPERATIONS[name].channel).toBe(MEDIA_CACHE_IPC[name]);
    }
  });

  it("registers one main handler per registry operation", () => {
    const bus = createInvokeBus();
    registerBridgeOperationHandlers(bus.ipcMain, buildHandlers());

    expect([...bus.channels.keys()].sort()).toEqual(
      BRIDGE_OPERATION_NAMES.map((name) => BRIDGE_OPERATIONS[name].channel).sort(),
    );
  });

  it("forwards invoke arguments to main handlers without the IPC event", async () => {
    const bus = createInvokeBus();
    const syncNow = vi.fn<() => Promise<undefined>>(async () => undefined);
    const listByIndex = vi.fn<BridgeOperationHandlers["listByIndex"]>(async () => ({
      items: [],
      nextCursor: null,
    }));
    registerBridgeOperationHandlers(bus.ipcMain, buildHandlers({ syncNow, listByIndex }));

    await bus.channels.get(BRIDGE_OPERATIONS.syncNow.channel)!({ sender: "fake-event" });
    await bus.channels.get(BRIDGE_OPERATIONS.listByIndex.channel)!(
      { sender: "fake-event" },
      "mimeType",
      "video/mp4",
      { limit: 5 },
    );

    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledWith();
    expect(listByIndex).toHaveBeenCalledTimes(1);
    expect(listByIndex).toHaveBeenCalledWith("mimeType", "video/mp4", { limit: 5 });
  });

  it("invokes registry channels from the preload invokers", async () => {
    const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(
      async () => undefined,
    );
    const invokers = createBridgeOperationInvokers({ invoke });

    await invokers.getStatus();
    await invokers.syncNow();
    await invokers.getAsset("forest");
    await invokers.listByIndex("mimeType", "video/mp4", { limit: 10, cursor: "c1" });
    await invokers.findByFileStem("main", { limit: 2 });

    expect(invoke).toHaveBeenNthCalledWith(1, BRIDGE_OPERATIONS.getStatus.channel);
    expect(invoke).toHaveBeenNthCalledWith(2, BRIDGE_OPERATIONS.syncNow.channel);
    expect(invoke).toHaveBeenNthCalledWith(3, BRIDGE_OPERATIONS.getAsset.channel, "forest");
    expect(invoke).toHaveBeenNthCalledWith(
      4,
      BRIDGE_OPERATIONS.listByIndex.channel,
      "mimeType",
      "video/mp4",
      { limit: 10, cursor: "c1" },
    );
    expect(invoke).toHaveBeenNthCalledWith(5, BRIDGE_OPERATIONS.findByFileStem.channel, "main", {
      limit: 2,
    });
  });

  it("round-trips every operation between preload invokers and main handlers", async () => {
    const bus = createInvokeBus();
    const status = buildStatus();
    const syncNow = vi.fn<() => Promise<undefined>>(async () => undefined);
    registerBridgeOperationHandlers(
      bus.ipcMain,
      buildHandlers({ getStatus: async () => status, syncNow }),
    );
    const invokers = createBridgeOperationInvokers(bus.ipcRenderer);

    await expect(invokers.getStatus()).resolves.toEqual(status);
    await expect(invokers.syncNow()).resolves.toBeUndefined();
    await expect(invokers.getAsset("forest")).resolves.toBeNull();
    await expect(invokers.listByIndex("mimeType", "video/mp4", { limit: 10 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(invokers.findByFileStem("main")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  it("accepts bridges exposing every registry operation", () => {
    expect(hasBridgeOperations(buildHandlers())).toBe(true);
  });

  it("rejects bridges missing any registry operation", () => {
    expect(hasBridgeOperations(null)).toBe(false);
    expect(hasBridgeOperations(undefined)).toBe(false);
    expect(hasBridgeOperations("bridge")).toBe(false);
    for (const name of BRIDGE_OPERATION_NAMES) {
      const incomplete: Record<string, unknown> = { ...buildHandlers() };
      delete incomplete[name];
      expect(hasBridgeOperations(incomplete)).toBe(false);
    }
  });
});
