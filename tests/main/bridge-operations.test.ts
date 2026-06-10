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
    registerBridgeOperationHandlers(bus.ipcMain, buildHandlers({ syncNow }));

    await bus.channels.get(BRIDGE_OPERATIONS.syncNow.channel)!({ sender: "fake-event" });

    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledWith();
  });

  it("invokes registry channels from the preload invokers", async () => {
    const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(
      async () => undefined,
    );
    const invokers = createBridgeOperationInvokers({ invoke });

    await invokers.getStatus();
    await invokers.syncNow();

    expect(invoke).toHaveBeenNthCalledWith(1, BRIDGE_OPERATIONS.getStatus.channel);
    expect(invoke).toHaveBeenNthCalledWith(2, BRIDGE_OPERATIONS.syncNow.channel);
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
