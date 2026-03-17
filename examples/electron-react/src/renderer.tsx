import React from "react";
import { createRoot } from "react-dom/client";
import { MediaCacheProvider } from "@rockhallweb/electron-offline-content/react";
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
