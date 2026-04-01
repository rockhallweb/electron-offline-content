/**
 * Example manifest for `createMediaCache({ resolveManifest })`. Replace with your own
 * fetch or file read; shape must match `MediaCacheManifest` from the package.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaCacheManifest } from "@rockhallweb/electron-offline-content/main";
import { exampleClientConfig, type ExampleClientConfig } from "./example-client-config.js";

export type { ExampleClientConfig };

// Resolve fixtures relative to this module, not process.cwd(), so packaged runs still work.
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "local");

export interface ExampleContext {
  clientConfig: ExampleClientConfig;
  resolveManifest: () => Promise<MediaCacheManifest>;
  dispose: () => Promise<void>;
}

export async function createExampleContext(): Promise<ExampleContext> {
  const server = await startFixtureServer();
  return {
    clientConfig: exampleClientConfig,
    resolveManifest: async () => localManifest(server.baseUrl),
    dispose: () => server.close(),
  };
}

function localManifest(baseUrl: string): MediaCacheManifest {
  return {
    snapshotId: "local-fixtures-v1",
    retrievedAt: new Date().toISOString(),
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
              curatorNote: "Fixture-driven kiosk content for local demo.",
            },
            assets: [
              {
                id: "main",
                role: "primary",
                kind: "video",
                byteLength: 14638,
                source: {
                  url: `${baseUrl}/forest-loop.mp4`,
                },
              },
              {
                id: "poster",
                role: "poster",
                kind: "poster",
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
            summary: "Used for subtree and file stem lookup in the example app.",
            blobs: {
              captionExcerpt: "A quiet looping cut for namespace-tree validation.",
            },
            assets: [
              {
                id: "main",
                role: "primary",
                kind: "video",
                byteLength: 14600,
                source: {
                  url: `${baseUrl}/rose-cut.mp4`,
                },
              },
              {
                id: "subtitles",
                role: "subtitle",
                kind: "subtitle",
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
