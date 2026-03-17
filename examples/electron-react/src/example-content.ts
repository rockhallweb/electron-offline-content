import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { MediaCacheManifest } from "@rockhallweb/electron-offline-content/main";

const fixturesDir = join(process.cwd(), "fixtures", "local");

export type ExampleProfileName = "local" | "nasa";

export interface ExampleClientConfig {
  profile: ExampleProfileName;
  rootNamespace: string;
  itemLookup: {
    namespace: string;
    itemId: string;
  };
  fileStem: string;
  namespaceTreePrefix: string;
}

export interface ExampleProfileContext {
  clientConfig: ExampleClientConfig;
  resolveManifest: () => Promise<MediaCacheManifest>;
  dispose: () => Promise<void>;
}

export async function createExampleProfile(
  profile: ExampleProfileName,
): Promise<ExampleProfileContext> {
  if (profile === "nasa") {
    return {
      clientConfig: {
        profile,
        rootNamespace: "space",
        itemLookup: {
          namespace: "space",
          itemId: "hubble-cosmos",
        },
        fileStem: "mars-large-organics",
        namespaceTreePrefix: "space",
      },
      resolveManifest: async () => nasaManifest(),
      dispose: async () => undefined,
    };
  }

  const server = await startFixtureServer();
  return {
    clientConfig: {
      profile,
      rootNamespace: "nature",
      itemLookup: {
        namespace: "nature",
        itemId: "forest-loop",
      },
      fileStem: "rose-cut",
      namespaceTreePrefix: "nature",
    },
    resolveManifest: async () => localManifest(server.baseUrl),
    dispose: () => server.close(),
  };
}

function localManifest(baseUrl: string): MediaCacheManifest {
  return {
    snapshotId: "local-fixtures-v1",
    generatedAt: new Date().toISOString(),
    namespaces: [
      {
        key: "nature",
        label: "Nature Queue",
        items: [
          {
            id: "forest-loop",
            version: "2026-03-forest-v1",
            kind: "video",
            title: "Forest Loop",
            description: "Local fixture video with a paired poster image.",
            summary: "Fixture item used for exact namespace lookup.",
            blobs: {
              curatorNote: "Fixture-driven kiosk content for deterministic smoke validation.",
            },
            assets: [
              {
                id: "main",
                role: "primary",
                kind: "video",
                fileName: "forest-loop.mp4",
                byteLength: 14638,
                source: {
                  url: `${baseUrl}/forest-loop.mp4`,
                },
              },
              {
                id: "poster",
                role: "poster",
                kind: "poster",
                fileName: "forest-poster.jpg",
                byteLength: 3284,
                source: {
                  url: `${baseUrl}/forest-poster.jpg`,
                },
              },
            ],
          },
        ],
      },
      {
        key: "nature.flowerVideos",
        label: "Flower Videos",
        items: [
          {
            id: "rose-cut",
            version: "2026-03-rose-v1",
            kind: "video",
            title: "Rose Cut",
            description: "Subtree fixture item with a subtitle track.",
            summary: "Used for subtree and file stem lookup smoke tests.",
            blobs: {
              captionExcerpt: "A quiet looping cut for namespace-tree validation.",
            },
            assets: [
              {
                id: "main",
                role: "primary",
                kind: "video",
                fileName: "rose-cut.mp4",
                byteLength: 14600,
                source: {
                  url: `${baseUrl}/rose-cut.mp4`,
                },
              },
              {
                id: "subtitles",
                role: "subtitle",
                kind: "subtitle",
                fileName: "rose-cut.vtt",
                byteLength: 97,
                source: {
                  url: `${baseUrl}/rose-cut.vtt`,
                },
              },
            ],
          },
        ],
      },
    ],
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
              sourceNote: "NASA demo profile for manual smoke and showcase sessions.",
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

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const filePath = join(fixturesDir, pathname === "/" ? "forest-loop.mp4" : pathname.slice(1));

    try {
      const payload = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Content-Length": payload.byteLength,
        "Cache-Control": "no-store",
      });
      response.end(payload);
    } catch {
      response.writeHead(404);
      response.end("missing fixture");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected fixture server to bind a TCP port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case ".mp4":
      return "video/mp4";
    case ".jpg":
      return "image/jpeg";
    case ".vtt":
      return "text/vtt";
    default:
      return "application/octet-stream";
  }
}
