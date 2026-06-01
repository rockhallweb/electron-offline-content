import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMediaProtocolHandler } from "../../src/main/media-protocol.js";

describe("createMediaProtocolHandler", () => {
  it("returns 404 for malformed asset URLs and missing catalog targets", async () => {
    const handler = createMediaProtocolHandler({
      catalog: {
        getProtocolAssetTarget: () => null,
      },
      emitLog: () => undefined,
    });

    await expect(handler(new Request("media://not-asset/key"))).resolves.toMatchObject({
      status: 404,
    });
    await expect(handler(new Request("media://asset/a/b"))).resolves.toMatchObject({
      status: 404,
    });
    await expect(handler(new Request("media://asset/%E0%A4%A"))).resolves.toMatchObject({
      status: 404,
    });
    await expect(handler(new Request("media://asset/missing"))).resolves.toMatchObject({
      status: 404,
    });
  });

  it("serves full, HEAD, bounded range, suffix range, and invalid range responses", async () => {
    const root = mkdtempSync(join(tmpdir(), "media-protocol-"));
    try {
      const filePath = join(root, "clip.mp4");
      writeFileSync(filePath, "video-one");
      const handler = createMediaProtocolHandler({
        catalog: {
          getProtocolAssetTarget: (assetKey) =>
            assetKey === "clip" ? { absolutePath: filePath } : null,
        },
        emitLog: () => undefined,
      });

      const full = await handler(new Request("media://asset/clip"));
      expect(full.status).toBe(200);
      expect(full.headers.get("content-type")).toBe("video/mp4");
      expect(await full.text()).toBe("video-one");

      const head = await handler(new Request("media://asset/clip", { method: "HEAD" }));
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("9");
      expect(await head.text()).toBe("");

      const bounded = await handler(
        new Request("media://asset/clip", { headers: { range: "bytes=0-4" } }),
      );
      expect(bounded.status).toBe(206);
      expect(bounded.headers.get("content-range")).toBe("bytes 0-4/9");
      expect(await bounded.text()).toBe("video");

      const suffix = await handler(
        new Request("media://asset/clip", { headers: { range: "bytes=-5" } }),
      );
      expect(suffix.status).toBe(206);
      expect(suffix.headers.get("content-range")).toBe("bytes 4-8/9");
      expect(await suffix.text()).toBe("o-one");

      const invalid = await handler(
        new Request("media://asset/clip", { headers: { range: "bytes=99-100" } }),
      );
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get("content-range")).toBe("bytes */9");
      expect(await invalid.text()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
