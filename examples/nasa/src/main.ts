/**
 * Main-process wiring for @rockhallweb/electron-offline-content: create the cache (before
 * app readiness so offline `media:` registration runs), register the protocol handler after
 * ready, sync from your manifest, then expose IPC so the renderer can query status and URLs.
 */
import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { createMediaCache } from "@rockhallweb/electron-offline-content/main";
import { createExampleContext } from "./fetch-content.js";

void bootstrap().catch((error) => {
  console.error(error);
  app.exit(1);
});

async function bootstrap() {
  const example = await createExampleContext();

  const storageRoot = join(
    app.getPath("temp"),
    "rockhallweb-electron-offline-content-example",
    "nasa",
  );

  const mediaCache = createMediaCache({
    storageRoot,
    resolveManifest: example.resolveManifest,
  });

  const createWindow = (): BrowserWindow => {
    const window = new BrowserWindow({
      width: 1380,
      height: 920,
      backgroundColor: "#0d1116",
      titleBarStyle: "hiddenInset",
      webPreferences: {
        preload: join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
      void window.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }

    window.once("ready-to-show", () => window.show());

    return window;
  };

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => void example.dispose());

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  await app.whenReady();

  await mediaCache.registerProtocol();

  // Renderer talks to the cache over IPC (`window.mediaCache`); hooks use this channel.
  await mediaCache.attachIpc();
  await mediaCache.start();

  createWindow();
}
