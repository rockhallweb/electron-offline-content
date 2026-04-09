import type { MediaCacheBridge } from "../shared/types.js";

declare global {
  interface Window {
    mediaCache?: MediaCacheBridge;
  }
}

export {};
