// Required: exposes `window.mediaCache` (IPC bridge). Your app can add more on `contextBridge` as needed.
import { contextBridge } from "electron";
import { exposeMediaCacheBridge } from "@rockhallweb/electron-offline-content/preload";
import { exampleClientConfig, type ExampleClientConfig } from "./example-client-config.js";

declare global {
  interface Window {
    mediaCacheExample?: ExampleClientConfig;
  }
}

const bridge = exposeMediaCacheBridge();

contextBridge.exposeInMainWorld("mediaCacheExample", exampleClientConfig);

export { bridge };
