import { exposeMediaCacheBridge } from "@rockhall/electron-offline-content/preload";

// Expose the media cache bridge on the window object
const bridge = exposeMediaCacheBridge();

export { bridge };
