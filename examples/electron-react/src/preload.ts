import { contextBridge } from "electron";
import { exposeMediaCacheBridge } from "@rockhallweb/electron-offline-content/preload";
import type { ExampleClientConfig } from "./example-content.js";

declare global {
  interface Window {
    mediaCacheExample?: ExampleClientConfig;
  }
}

const bridge = exposeMediaCacheBridge();
const cliConfig = readClientConfig();

const exampleConfig: ExampleClientConfig = cliConfig ?? {
  profile: process.env.MEDIA_CACHE_EXAMPLE_PROFILE === "nasa" ? "nasa" : "local",
  rootNamespace: process.env.MEDIA_CACHE_EXAMPLE_ROOT_NAMESPACE ?? "nature",
  itemLookup: {
    namespace: process.env.MEDIA_CACHE_EXAMPLE_ITEM_NAMESPACE ?? "nature",
    itemId: process.env.MEDIA_CACHE_EXAMPLE_ITEM_ID ?? "forest-loop",
  },
  fileStem: process.env.MEDIA_CACHE_EXAMPLE_FILE_STEM ?? "rose-cut",
  namespaceTreePrefix: process.env.MEDIA_CACHE_EXAMPLE_NAMESPACE_TREE_PREFIX ?? "nature",
};

contextBridge.exposeInMainWorld("mediaCacheExample", exampleConfig);

export { bridge };

function readClientConfig(): ExampleClientConfig | null {
  const prefix = "--media-cache-example-config=";
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  if (!arg) {
    return null;
  }

  const encoded = arg.slice(prefix.length);
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ExampleClientConfig;
  } catch {
    return null;
  }
}
