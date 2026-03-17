import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { copyFileSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaCache, createMediaCache } from '../../src/main/media-cache.js';
import { normalizeManifest } from '../../src/shared/normalize.js';
import { ManifestValidationError } from '../../src/shared/errors.js';
import type { ManifestInput, MediaCacheLogEvent } from '../../src/shared/types.js';

describe('manifest normalization', () => {
  it('normalizes flat arrays into the default namespace', () => {
    const manifest = normalizeManifest([
      {
        id: 'item-1',
        version: 'v1',
        kind: 'video',
        assets: [
          {
            id: 'main',
            role: 'primary',
            kind: 'video',
            source: {
              url: 'https://example.com/file.mp4',
            },
          },
        ],
      },
    ]);

    expect(manifest.namespaces).toHaveLength(1);
    expect(manifest.namespaces[0]?.key).toBe('default');
    expect(manifest.namespaces[0]?.items[0]?.assets[0]?.normalizedFileName).toBe('file.mp4');
  });

  it('rejects duplicate namespace keys, item ids, and asset ids', () => {
    expect(() =>
      normalizeManifest({
        namespaces: [
          {
            key: 'dup',
            items: [],
          },
          {
            key: 'dup',
            items: [],
          },
        ],
      }),
    ).toThrow(ManifestValidationError);

    expect(() =>
      normalizeManifest({
        namespaces: [
          {
            key: 'gallery',
            items: [
              {
                id: 'same',
                version: 'v1',
                kind: 'image',
                assets: [],
              },
              {
                id: 'same',
                version: 'v1',
                kind: 'image',
                assets: [],
              },
            ],
          },
        ],
      }),
    ).toThrow(ManifestValidationError);

    expect(() =>
      normalizeManifest({
        namespaces: [
          {
            key: 'gallery',
            items: [
              {
                id: 'item',
                version: 'v1',
                kind: 'image',
                assets: [
                  {
                    id: 'dup',
                    role: 'primary',
                    kind: 'image',
                    source: { url: 'https://example.com/a.jpg' },
                  },
                  {
                    id: 'dup',
                    role: 'thumbnail',
                    kind: 'thumbnail',
                    source: { url: 'https://example.com/b.jpg' },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(ManifestValidationError);
  });
});

describe('media cache sync and queries', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl = '';
  let requestCounts: Record<string, number>;
  let manifests: ManifestInput;

  beforeAll(async () => {
    requestCounts = {};
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url ?? '/';
      requestCounts[path] = (requestCounts[path] ?? 0) + 1;

      if (path === '/broken.mp4') {
        res.writeHead(500);
        res.end('broken');
        return;
      }

      const payloads: Record<string, string> = {
        '/main.mp4': 'video-one',
        '/poster.jpg': 'poster',
        '/flower.mp4': 'flower-video',
        '/sub.vtt': 'WEBVTT',
      };
      const body = payloads[path];
      if (!body) {
        res.writeHead(404);
        res.end('missing');
        return;
      }

      res.writeHead(200, {
        'Content-Type': path.endsWith('.jpg')
          ? 'image/jpeg'
          : path.endsWith('.vtt')
            ? 'text/vtt'
            : 'video/mp4',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    requestCounts = {};
    manifests = {
      snapshotId: 'initial',
      namespaces: [
        {
          key: 'nature',
          items: [
            {
              id: 'forest',
              version: 'v1',
              kind: 'video',
              title: 'Forest',
              assets: [
                {
                  id: 'main',
                  role: 'primary',
                  kind: 'video',
                  fileName: 'main.mp4',
                  byteLength: 9,
                  source: {
                    url: `${baseUrl}/main.mp4`,
                  },
                },
                {
                  id: 'poster',
                  role: 'poster',
                  kind: 'poster',
                  fileName: 'poster.jpg',
                  byteLength: 6,
                  source: {
                    url: `${baseUrl}/poster.jpg`,
                  },
                },
              ],
            },
          ],
        },
        {
          key: 'nature.flowerVideos',
          items: [
            {
              id: 'rose',
              version: 'v1',
              kind: 'video',
              assets: [
                {
                  id: 'main',
                  role: 'primary',
                  kind: 'video',
                  fileName: 'flower.mp4',
                  byteLength: 12,
                  source: {
                    url: `${baseUrl}/flower.mp4`,
                  },
                },
                {
                  id: 'captions',
                  role: 'subtitle',
                  kind: 'subtitle',
                  fileName: 'sub.vtt',
                  byteLength: 6,
                  source: {
                    url: `${baseUrl}/sub.vtt`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
  });

  function createStorageRoot(): string {
    return mkdtempSync(join(tmpdir(), 'media-cache-test-'));
  }

  it('syncs a manifest, preserves manifest order, supports tree queries, and finds file stems', async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    const item = await cache.getItem('nature', 'forest');
    expect(item?.title).toBe('Forest');
    expect(item?.assets[0]?.url).toBe('media://asset/nature/forest/main');

    const namespaceList = await cache.listNamespace('nature', { limit: 10 });
    expect(namespaceList.items.map((entry) => entry.id)).toEqual(['forest']);

    const treeList = await cache.listNamespaceTree('nature', { limit: 10 });
    expect(treeList.items.map((entry) => `${entry.namespace}/${entry.id}`)).toEqual([
      'nature/forest',
      'nature.flowerVideos/rose',
    ]);

    const fileStem = await cache.findByFileStem('flower', { limit: 10 });
    expect(fileStem.items).toHaveLength(1);
    expect(fileStem.items[0]?.item.id).toBe('rose');
    expect(fileStem.items[0]?.matchedAssetIds).toEqual(['main']);
  });

  it('skips unchanged downloads and redownloads when the version changes', async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();
    expect(requestCounts['/main.mp4']).toBe(1);

    await cache.syncNow();
    expect(requestCounts['/main.mp4']).toBe(1);

    manifests = {
      snapshotId: 'v2',
      namespaces: [
        {
          key: 'nature',
          items: [
            {
              id: 'forest',
              version: 'v2',
              kind: 'video',
              assets: [
                {
                  id: 'main',
                  role: 'primary',
                  kind: 'video',
                  fileName: 'main.mp4',
                  byteLength: 9,
                  source: {
                    url: `${baseUrl}/main.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    await cache.syncNow();
    expect(requestCounts['/main.mp4']).toBe(2);
  });

  it('reuses cached assets when stored relative paths use windows separators', async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();
    expect(requestCounts['/main.mp4']).toBe(1);

    const db = (cache as unknown as { db: {
      getActiveGenerationId(): number | null;
      getGenerationAssets(generationId: number): Array<{ namespace: string; itemId: string; assetId: string; relativePath: string | null }>;
      setAssetRelativePath(
        generationId: number,
        namespace: string,
        itemId: string,
        assetId: string,
        relativePath: string,
      ): void;
    } }).db;
    const activeGenerationId = db.getActiveGenerationId();
    expect(activeGenerationId).not.toBeNull();

    const mainAsset = db
      .getGenerationAssets(activeGenerationId!)
      .find((row) => row.namespace === 'nature' && row.itemId === 'forest' && row.assetId === 'main');
    expect(mainAsset?.relativePath).toBeTruthy();

    const originalPath = join(storageRoot, mainAsset!.relativePath!);
    const windowsRelativePath = 'blobs\\nature\\forest\\main\\v1\\main.mp4';
    copyFileSync(originalPath, join(storageRoot, windowsRelativePath));
    db.setAssetRelativePath(activeGenerationId!, 'nature', 'forest', 'main', windowsRelativePath);

    await cache.syncNow();
    expect(requestCounts['/main.mp4']).toBe(1);
  });

  it('supports pipe characters in namespace, item, and asset ids', async () => {
    const storageRoot = createStorageRoot();
    manifests = {
      snapshotId: 'pipe-ids',
      namespaces: [
        {
          key: 'nature|archive',
          items: [
            {
              id: 'forest|loop',
              version: 'v1',
              kind: 'video',
              assets: [
                {
                  id: 'main|primary',
                  role: 'primary',
                  kind: 'video',
                  fileName: 'main.mp4',
                  byteLength: 9,
                  source: {
                    url: `${baseUrl}/main.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const cache = createMediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();
    const item = await cache.getItem('nature|archive', 'forest|loop');
    expect(item?.assets[0]?.url).toBe('media://asset/nature%7Carchive/forest%7Cloop/main%7Cprimary');

    const matches = await cache.findByFileStem('main', { limit: 10 });
    expect(matches.items).toHaveLength(1);
    expect(matches.items[0]?.item.namespace).toBe('nature|archive');
    expect(matches.items[0]?.item.id).toBe('forest|loop');
    expect(matches.items[0]?.matchedAssetIds).toEqual(['main|primary']);
  });

  it('marks removed assets for deletion instead of deleting them immediately', async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();
    const initialBlobRoot = join(storageRoot, 'blobs');
    const filesBefore = collectFiles(initialBlobRoot);
    expect(filesBefore.length).toBeGreaterThan(0);

    manifests = {
      snapshotId: 'empty',
      namespaces: [],
    };

    await cache.syncNow();
    const filesAfter = collectFiles(initialBlobRoot);
    expect(filesAfter).toEqual(filesBefore);
    const item = await cache.getItem('nature', 'forest');
    expect(item).toBeNull();
  });

  it('serves the last committed snapshot on sync failure by default', async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    manifests = {
      snapshotId: 'broken',
      namespaces: [
        {
          key: 'nature',
          items: [
            {
              id: 'forest',
              version: 'v2',
              kind: 'video',
              assets: [
                {
                  id: 'main',
                  role: 'primary',
                  kind: 'video',
                  fileName: 'broken.mp4',
                  byteLength: 6,
                  source: {
                    url: `${baseUrl}/broken.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    await expect(cache.syncNow()).resolves.toBeUndefined();
    const item = await cache.getItem('nature', 'forest');
    expect(item?.version).toBe('v1');
    const status = await cache.getStatus();
    expect(status.error?.code).toBe('SYNC_FAILURE');
  });

  it('throws on sync failure when configured', async () => {
    const storageRoot = createStorageRoot();
    const cache = createMediaCache({
      storageRoot,
      onSyncFailure: 'throw',
      resolveManifest: () => manifests,
    });

    await cache.start();

    manifests = {
      snapshotId: 'broken',
      namespaces: [
        {
          key: 'nature',
          items: [
            {
              id: 'forest',
              version: 'v2',
              kind: 'video',
              assets: [
                {
                  id: 'main',
                  role: 'primary',
                  kind: 'video',
                  fileName: 'broken.mp4',
                  byteLength: 6,
                  source: {
                    url: `${baseUrl}/broken.mp4`,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    await expect(cache.syncNow()).rejects.toThrow();
    const item = await cache.getItem('nature', 'forest');
    expect(item?.version).toBe('v1');
  });

  it('registers a protocol handler that resolves committed files only', async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    let handler: ((request: { url: string }) => Promise<Response>) | null = null;
    const fakeSession = {
      protocol: {
        handle: (_scheme: string, nextHandler: (request: { url: string }) => Promise<Response>) => {
          handler = nextHandler;
        },
      },
    } as unknown as NonNullable<Parameters<MediaCache['registerProtocol']>[0]>['session'];

    await cache.registerProtocol({
      session: fakeSession,
      fetchFile: async (_request, filePath) => new Response(readFileSync(filePath, 'utf8')),
    });

    expect(handler).not.toBeNull();
    const response = await handler!(
      new Request('media://asset/nature/forest/main'),
    );
    expect(await response.text()).toBe('video-one');

    const missing = await handler!(
      new Request('media://asset/nature/forest/missing'),
    );
    expect(missing.status).toBe(404);
  });

  it('serves byte ranges for committed video assets', async () => {
    const storageRoot = createStorageRoot();
    const cache = new MediaCache({
      storageRoot,
      resolveManifest: () => manifests,
    });

    await cache.start();

    let handler: ((request: Request) => Promise<Response>) | null = null;
    const fakeSession = {
      protocol: {
        handle: (_scheme: string, nextHandler: (request: Request) => Promise<Response>) => {
          handler = nextHandler;
        },
      },
    } as unknown as NonNullable<Parameters<MediaCache['registerProtocol']>[0]>['session'];

    await cache.registerProtocol({
      session: fakeSession,
    });

    expect(handler).not.toBeNull();
    const response = await handler!(
      new Request('media://asset/nature/forest/main', {
        headers: {
          range: 'bytes=0-4',
        },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 0-4/9');
    expect(await response.text()).toBe('video');
  });

  it('emits structured log events through the consumer callback', async () => {
    const storageRoot = createStorageRoot();
    const logs: MediaCacheLogEvent[] = [];
    const cache = createMediaCache({
      storageRoot,
      logLevel: 'debug',
      onLog: (entry) => {
        logs.push(entry);
      },
      resolveManifest: () => manifests,
    });

    await cache.start();

    expect(logs.some((entry) => entry.event === 'cache_initialized')).toBe(true);
    expect(logs.some((entry) => entry.event === 'sync_started')).toBe(true);
    expect(logs.some((entry) => entry.event === 'sync_completed')).toBe(true);
    expect(logs.some((entry) => entry.event === 'asset_download_started')).toBe(true);
    expect(logs.every((entry) => entry.service === 'rockhallweb-electron-offline-content')).toBe(
      true,
    );
    expect(logs.every((entry) => entry.component === 'media-cache')).toBe(true);
  });

  it('falls back to the default storage root when storageRoot is blank', async () => {
    const homeRoot = createStorageRoot();
    const originalHome = process.env.HOME;
    const originalLocalAppData = process.env.LOCALAPPDATA;

    process.env.HOME = homeRoot;
    process.env.LOCALAPPDATA = join(homeRoot, 'AppData', 'Local');

    try {
      const cache = new MediaCache({
        storageRoot: '   ',
        resolveManifest: () => ({
          snapshotId: 'blank-storage-root',
          namespaces: [],
        }),
      });

      await cache.start();

      const activeStorageRoot = (cache as unknown as { storageRoot: string | null }).storageRoot;
      const expectedStorageRoot =
        process.platform === 'darwin'
          ? join(homeRoot, 'Library', 'Caches', 'electron-offline-content', 'media-cache')
          : process.platform === 'win32'
            ? join(homeRoot, 'AppData', 'Local', 'electron-offline-content', 'media-cache')
            : join(homeRoot, '.cache', 'electron-offline-content', 'media-cache');
      expect(activeStorageRoot).toBe(expectedStorageRoot);
      expect(existsSync(activeStorageRoot!)).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
      rmSync(homeRoot, { recursive: true, force: true });
    }
  });
});

function collectFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return walk(root).sort();
}

function walk(path: string): string[] {
  const stats = existsSync(path) ? readFileSafe(path) : null;
  if (stats === null) {
    return [];
  }
  if (stats.type === 'file') {
    return [path];
  }

  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

function readFileSafe(path: string): { type: 'file' | 'directory' } | null {
  try {
    const stats = statSync(path);
    return { type: stats.isDirectory() ? 'directory' : 'file' };
  } catch {
    return null;
  }
}
