import { exposeMediaCacheBridge } from "@rockhallweb/electron-offline-content/preload";

// Expose the media cache bridge on the window object
const bridge = exposeMediaCacheBridge();

export { bridge };
