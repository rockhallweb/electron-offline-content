import React from "react";
import { createRoot } from "react-dom/client";
// Provider supplies React context backed by the IPC bridge from preload.
import { MediaCacheProvider } from "@rockhall/electron-offline-content/react";
import { App } from "./App.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Expected #root to exist.");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <MediaCacheProvider>
      <App />
    </MediaCacheProvider>
  </React.StrictMode>,
);
