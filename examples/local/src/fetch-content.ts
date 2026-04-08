/**
 * Example store for `createMediaCache({ resolveStore })`. Replace with your own
 * fetch or file read; build a `MediaStore` using the flat key-value API.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMediaStore, type MediaStore } from "@rockhallweb/electron-offline-content/main";
import { exampleClientConfig, type ExampleClientConfig } from "./example-client-config.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "local");

export interface ExampleContext {
  clientConfig: ExampleClientConfig;
  resolveStore: () => Promise<MediaStore>;
  dispose: () => Promise<void>;
}

export async function createExampleContext(): Promise<ExampleContext> {
  const server = await startFixtureServer();
  return {
    clientConfig: exampleClientConfig,
    resolveStore: async () => buildStore(server.baseUrl),
    dispose: () => server.close(),
  };
}

function buildStore(baseUrl: string): MediaStore {
  const store = createMediaStore({
    snapshotId: "local-fixtures-v1",
    retrievedAt: new Date().toISOString(),
  });

  const collection = store.defineIndex("collection");
  const role = store.defineIndex("role");

  store.add("nature/forest-loop/main", {
    version: "2026-03-forest-v1",
    mimeType: "video/mp4",
    byteLength: 14638,
    source: { url: `${baseUrl}/forest-loop.mp4` },
    metadata: {
      title: "Forest Loop",
      description: "Local fixture video with a paired poster image.",
      summary: "Fixture item used for exact namespace lookup.",
      curatorNote: "Fixture-driven kiosk content for local demo.",
    },
    indexes: {
      [`${collection}`]: "nature",
      [`${role}`]: "primary",
    },
  });

  store.add("nature/forest-loop/poster", {
    version: "2026-03-forest-v1",
    mimeType: "image/jpeg",
    byteLength: 3284,
    source: { url: `${baseUrl}/forest-poster.jpg` },
    metadata: {
      title: "Forest Loop – Poster",
      parentKey: "nature/forest-loop/main",
    },
    indexes: {
      [`${collection}`]: "nature",
      [`${role}`]: "poster",
    },
  });

  store.add("nature/rose-cut/main", {
    version: "2026-03-rose-v1",
    mimeType: "video/mp4",
    byteLength: 14600,
    source: { url: `${baseUrl}/rose-cut.mp4` },
    metadata: {
      title: "Rose Cut",
      description: "Subtree fixture item with a subtitle track.",
      summary: "Used for subtree and file stem lookup in the example app.",
      captionExcerpt: "A quiet looping cut for namespace-tree validation.",
    },
    indexes: {
      [`${collection}`]: "nature",
      [`${role}`]: "primary",
    },
  });

  store.add("nature/rose-cut/subtitles", {
    version: "2026-03-rose-v1",
    mimeType: "text/vtt",
    byteLength: 97,
    source: { url: `${baseUrl}/rose-cut.vtt` },
    metadata: {
      title: "Rose Cut – Subtitles",
      parentKey: "nature/rose-cut/main",
    },
    indexes: {
      [`${collection}`]: "nature",
      [`${role}`]: "subtitle",
    },
  });

  return store;
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
