import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMediaProtocolHandler,
  registerMediaProtocolHandler,
  type MediaProtocolAssetTarget,
  type MediaProtocolHandlerOptions,
} from "../../src/main/media-protocol.js";

function createBlobFile(fileName: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "media-protocol-test-"));
  const filePath = join(dir, fileName);
  writeFileSync(filePath, contents);
  return filePath;
}

function createHandlerForFile(
  filePath: string | null,
  overrides?: Partial<MediaProtocolHandlerOptions>,
): (request: Request) => Promise<Response> {
  return createMediaProtocolHandler({
    resolveAssetTarget: () => (filePath === null ? null : { absolutePath: filePath }),
    ...overrides,
  });
}

describe("media protocol request parsing", () => {
  it("returns 404 for URLs outside the asset hostname", async () => {
    const handler = createHandlerForFile(createBlobFile("main.mp4", "video-one"));

    const response = await handler(new Request("media://other/abc"));
    expect(response.status).toBe(404);
  });

  it("returns 404 for URLs with extra path segments", async () => {
    const handler = createHandlerForFile(createBlobFile("main.mp4", "video-one"));

    const response = await handler(new Request("media://asset/abc/def"));
    expect(response.status).toBe(404);
  });

  it("returns 404 for URLs without an asset key segment", async () => {
    const handler = createHandlerForFile(createBlobFile("main.mp4", "video-one"));

    const response = await handler(new Request("media://asset/"));
    expect(response.status).toBe(404);
  });

  it("returns 404 for malformed percent-encoding in the asset key", async () => {
    const lookups: string[] = [];
    const handler = createMediaProtocolHandler({
      resolveAssetTarget: (assetKey) => {
        lookups.push(assetKey);
        return null;
      },
    });

    const response = await handler(new Request("media://asset/foo%GG"));
    expect(response.status).toBe(404);
    expect(lookups).toEqual([]);
  });

  it("decodes percent-encoded asset keys before catalog lookup", async () => {
    const lookups: string[] = [];
    const filePath = createBlobFile("main.mp4", "video-one");
    const handler = createMediaProtocolHandler({
      resolveAssetTarget: (assetKey) => {
        lookups.push(assetKey);
        return { absolutePath: filePath };
      },
    });

    const response = await handler(new Request("media://asset/nature%2Fforest%2Fmain"));
    expect(response.status).toBe(200);
    expect(lookups).toEqual(["nature/forest/main"]);
  });

  it("returns 404 and logs when the catalog has no matching asset", async () => {
    const events: Array<{ event: string; fields: Record<string, string | null> }> = [];
    const handler = createHandlerForFile(null, {
      onDebugLog: (event, fields) => {
        events.push({ event, fields });
      },
    });

    const response = await handler(new Request("media://asset/missing"));
    expect(response.status).toBe(404);
    expect(events).toEqual([
      {
        event: "protocol_request_not_found",
        fields: { asset_key: "missing", method: "GET" },
      },
    ]);
  });

  it("returns 404 when the catalog row has no local file", async () => {
    const handler = createMediaProtocolHandler({
      resolveAssetTarget: () => ({ absolutePath: null }),
    });

    const response = await handler(new Request("media://asset/pending"));
    expect(response.status).toBe(404);
  });

  it("returns 404 and logs when the committed blob is missing on disk", async () => {
    const events: string[] = [];
    const handler = createHandlerForFile(join(tmpdir(), "media-protocol-missing", "gone.mp4"), {
      onDebugLog: (event) => {
        events.push(event);
      },
    });

    const response = await handler(new Request("media://asset/gone"));
    expect(response.status).toBe(404);
    expect(events).toEqual(["protocol_request_file_missing"]);
  });

  it("logs the resolved request with the range header", async () => {
    const events: Array<{ event: string; fields: Record<string, string | null> }> = [];
    const handler = createHandlerForFile(createBlobFile("main.mp4", "video-one"), {
      onDebugLog: (event, fields) => {
        events.push({ event, fields });
      },
    });

    const response = await handler(
      new Request("media://asset/abc", { headers: { range: "bytes=0-3" } }),
    );
    expect(response.status).toBe(206);
    expect(events).toEqual([
      {
        event: "protocol_request_local_resolved",
        fields: { asset_key: "abc", method: "GET", range: "bytes=0-3" },
      },
    ]);
  });

  it("delegates resolved requests to a custom fetchFile handler", async () => {
    const filePath = createBlobFile("main.mp4", "video-one");
    const handler = createHandlerForFile(filePath, {
      fetchFile: async (_request, resolvedPath) =>
        new Response(`custom:${resolvedPath}`, { status: 200 }),
    });

    const response = await handler(new Request("media://asset/abc"));
    expect(await response.text()).toBe(`custom:${filePath}`);
  });
});

describe("media protocol file responses", () => {
  const body = "0123456789";

  function createFileHandler(fileName = "main.mp4"): (request: Request) => Promise<Response> {
    return createHandlerForFile(createBlobFile(fileName, body));
  }

  it("serves a full response with length, type, and accept-ranges headers", async () => {
    const handler = createFileHandler();

    const response = await handler(new Request("media://asset/abc"));
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(await response.text()).toBe(body);
  });

  it("serves HEAD responses with headers and no body", async () => {
    const handler = createFileHandler();

    const response = await handler(new Request("media://asset/abc", { method: "HEAD" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.body).toBeNull();
  });

  it("serves a bounded byte range as 206 with content-range", async () => {
    const handler = createFileHandler();

    const response = await handler(
      new Request("media://asset/abc", { headers: { range: "bytes=2-5" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 2-5/${body.length}`);
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("2345");
  });

  it("serves an open-ended byte range through the end of the file", async () => {
    const handler = createFileHandler();

    const response = await handler(
      new Request("media://asset/abc", { headers: { range: "bytes=4-" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 4-9/${body.length}`);
    expect(await response.text()).toBe("456789");
  });

  it("clamps a range end beyond the file size", async () => {
    const handler = createFileHandler();

    const response = await handler(
      new Request("media://asset/abc", { headers: { range: "bytes=6-999" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 6-9/${body.length}`);
    expect(await response.text()).toBe("6789");
  });

  it("serves a suffix range from the end of the file", async () => {
    const handler = createFileHandler();

    const response = await handler(
      new Request("media://asset/abc", { headers: { range: "bytes=-4" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 6-9/${body.length}`);
    expect(await response.text()).toBe("6789");
  });

  it("clamps a suffix range longer than the file to the full file", async () => {
    const handler = createFileHandler();

    const response = await handler(
      new Request("media://asset/abc", { headers: { range: "bytes=-999" } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-9/${body.length}`);
    expect(await response.text()).toBe(body);
  });

  it("returns 416 when the range start is past the end of the file", async () => {
    const handler = createFileHandler();

    const response = await handler(
      new Request("media://asset/abc", { headers: { range: "bytes=99-" } }),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${body.length}`);
  });

  it.each(["bytes=5-2", "bytes=0-1,3-4", "bytes=-0", "items=0-5"])(
    "returns 416 for unsupported range header %j",
    async (range) => {
      const handler = createFileHandler();

      const response = await handler(new Request("media://asset/abc", { headers: { range } }));
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${body.length}`);
    },
  );

  it.each(["bytes=1x-4", "bytes=--5", "bytes=1-2-3", "bytes=1-2x", "bytes=x-4", "bytes=1--2"])(
    "ignores malformed range header %j and serves the full 200 response",
    async (range) => {
      const handler = createFileHandler();

      const response = await handler(new Request("media://asset/abc", { headers: { range } }));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(body.length));
      expect(response.headers.get("content-range")).toBeNull();
      expect(await response.text()).toBe(body);
    },
  );

  it("infers MIME types from the blob file extension", async () => {
    const cases: Array<[string, string]> = [
      ["sample.webm", "video/webm"],
      ["sample.jpeg", "image/jpeg"],
      ["sample.vtt", "text/vtt"],
      ["sample.json", "application/json; charset=utf-8"],
      ["sample.bin", "application/octet-stream"],
    ];

    for (const [fileName, expectedMimeType] of cases) {
      const handler = createFileHandler(fileName);
      const response = await handler(new Request("media://asset/abc"));
      expect(response.headers.get("content-type")).toBe(expectedMimeType);
    }
  });
});

describe("registerMediaProtocolHandler", () => {
  it("registers the request handler for the media scheme", async () => {
    const filePath = createBlobFile("main.mp4", "video-one");
    const registrations: Array<{
      scheme: string;
      handler: (request: Request) => Promise<Response>;
    }> = [];
    const fakeSession = {
      protocol: {
        handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
          registrations.push({ scheme, handler });
        },
      },
    } as unknown as Parameters<typeof registerMediaProtocolHandler>[0];

    const target: MediaProtocolAssetTarget = { absolutePath: filePath };
    registerMediaProtocolHandler(fakeSession, {
      resolveAssetTarget: () => target,
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0].scheme).toBe("media");

    const response = await registrations[0].handler(new Request("media://asset/abc"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("video-one");
  });
});
