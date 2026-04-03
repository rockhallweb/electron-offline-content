/**
 * Main-process wiring for @rockhallweb/electron-offline-content: create the cache (before
 * app readiness so offline `media:` registration runs), register the protocol handler after
 * ready, sync from your manifest, then expose IPC so the renderer can query status and URLs.
 */
import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import { mediaCache } from "./offline-media.js";

const SINGLE_INSTANCE_ERROR_TITLE = "Example Already Running";
const SINGLE_INSTANCE_ERROR_MESSAGE =
  "Another instance of this example is already running. This app requires exclusive access to its offline cache, so this instance will now exit.";

if (!app.requestSingleInstanceLock()) {
  dialog.showErrorBox(SINGLE_INSTANCE_ERROR_TITLE, SINGLE_INSTANCE_ERROR_MESSAGE);
  app.exit(1);
} else {
  void bootstrap().catch((error) => {
    console.error(error);
    app.exit(1);
  });
}

async function bootstrap() {
  let mainWindow: BrowserWindow | null = null;
  const createWindow = (): BrowserWindow => {
    const window = new BrowserWindow({
      width: 1380,
      height: 920,
      backgroundColor: "#000000",
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
    window.on("closed", () => {
      if (mainWindow === window) {
        mainWindow = null;
      }
    });
    mainWindow = window;

    return window;
  };

  app.on("second-instance", () => {
    const window = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? createWindow();
    if (!window) {
      return;
    }

    if (window.isMinimized()) {
      window.restore();
    }

    window.focus();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (mainWindow === null) {
      createWindow();
    }
  });
  await app.whenReady();

  // Keep sync renderer-triggered so users explicitly download content in the demo UI.
  await mediaCache.registerProtocol();
  await mediaCache.attachIpc();

  createWindow();
}
