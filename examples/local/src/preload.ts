// Required: exposes `window.mediaCache` (IPC bridge). Your app can add more on `contextBridge` as needed.
import { exposeMediaCacheBridge } from "@rockhallweb/electron-offline-content/preload";

const bridge = exposeMediaCacheBridge();

export { bridge };
