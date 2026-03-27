/**
 * Example manifest for `createMediaCache({ resolveManifest })`. Replace with your own
 * fetch or file read; shape must match `MediaCacheManifest` from the package.
 */
import type { MediaCacheManifest } from "@rockhallweb/electron-offline-content/main";
import { exampleClientConfig, type ExampleClientConfig } from "./example-client-config.js";

export type { ExampleClientConfig };

export interface ExampleContext {
  clientConfig: ExampleClientConfig;
  resolveManifest: () => Promise<MediaCacheManifest>;
  dispose: () => Promise<void>;
}

export async function createExampleContext(): Promise<ExampleContext> {
  return {
    clientConfig: exampleClientConfig,
    resolveManifest: async () => nasaManifest(),
    dispose: async () => undefined,
  };
}

function nasaManifest(): MediaCacheManifest {
  return {
    snapshotId: "nasa-demo-v1",
    generatedAt: new Date().toISOString(),
    namespaces: [
      {
        key: "space",
        label: "NASA Demo",
        items: [
          {
            id: "hubble-cosmos",
            version: "nasa-hubble-2026",
            kind: "video",
            title: "Moon Tree Planting",
            description: "NASA feature clip used for the manual demo profile.",
            summary: "Current public NASA SVS asset for manual maintainer validation.",
            blobs: {
              sourceNote: "NASA demo profile for manual sessions.",
            },
            assets: [
              {
                id: "main",
                role: "primary",
                kind: "video",
                fileName: "moon-tree-planting.mp4",
                source: {
                  url: "https://svs.gsfc.nasa.gov/vis/a010000/a014900/a014929/14929_A1_Moon_Tree_Planting_720.mp4",
                },
              },
              {
                id: "poster",
                role: "poster",
                kind: "poster",
                fileName: "moon-tree-planting.jpg",
                source: {
                  url: "https://svs.gsfc.nasa.gov/vis/a010000/a014900/a014929/A1-Moon-Tree-Planting-Thumbnail_print.jpg",
                },
              },
            ],
          },
        ],
      },
      {
        key: "space.missions",
        label: "Mission Cuts",
        items: [
          {
            id: "mars-large-organics",
            version: "nasa-solar-system-2026",
            kind: "video",
            title: "Large Organics on Mars",
            description: "Additional NASA clip to exercise subtree queries in manual demos.",
            assets: [
              {
                id: "main",
                role: "primary",
                kind: "video",
                fileName: "mars-large-organics.mp4",
                source: {
                  url: "https://svs.gsfc.nasa.gov/vis/a010000/a014800/a014808/14808_Mars_Large_Organics_720.mp4",
                },
              },
              {
                id: "poster",
                role: "poster",
                kind: "poster",
                fileName: "mars-large-organics.jpg",
                source: {
                  url: "https://svs.gsfc.nasa.gov/vis/a010000/a014800/a014808/Mars_Large_Organics_Thumbnail_V3_print.jpg",
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
