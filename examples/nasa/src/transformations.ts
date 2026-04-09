/**
 * NASA Images API → Flat Asset Store Transformations
 *
 * This file turns raw NASA Images search results into flat assets for the
 * MediaStore. It handles:
 *
 * - Validating the NASA search response with Zod schemas
 * - Resolving the best available asset URL (video or image) from each
 *   item's collection, preferring higher-quality variants first
 * - Adding a primary and poster asset for each item with metadata
 * - Tagging assets with collection, mediaType, and role indexes
 *
 * Used by the NASA example app's offline-media store builder.
 */
import type { MediaIndex, MediaStore } from "@rockhallweb/electron-offline-content/main";
import { z } from "zod";

const NasaSearchItemDataLike = z.object({
  center: z.string(),
  date_created: z.string(),
  description: z.string(),
  keywords: z.array(z.string()).optional(),
  media_type: z.enum(["image", "video"]),
  nasa_id: z.string().min(1),
  title: z.string(),
});

const NasaSearchItemLike = z.object({
  href: z.string(),
  data: z.array(NasaSearchItemDataLike),
  links: z.array(
    z.object({
      href: z.string(),
      rel: z.string().optional(),
      render: z.string().optional(),
    }),
  ),
});
type NasaSearchItemLike = z.infer<typeof NasaSearchItemLike>;

const NasaSearchBranchLike = z.object({
  collection: z.object({
    href: z.string(),
    items: z.array(NasaSearchItemLike),
  }),
});
type NasaSearchBranchLike = z.infer<typeof NasaSearchBranchLike>;

/** NASA content schema for demo purposes */
export const NasaContentSchema = z.object({
  searches: z.object({
    image: NasaSearchBranchLike,
    video: NasaSearchBranchLike,
  }),
  assetCollections: z.record(z.string(), z.array(z.string())),
});
export type NasaContentSchema = z.infer<typeof NasaContentSchema>;

interface StoreIndexes {
  collection: MediaIndex;
  mediaType: MediaIndex;
  role: MediaIndex;
}

/** Populates a MediaStore with assets derived from NASA search results. */
export function populateStore(
  store: MediaStore,
  indexes: StoreIndexes,
  content: NasaContentSchema,
): void {
  addSearchItems(
    store,
    indexes,
    "space.images",
    content.searches.image.collection.items,
    content.assetCollections,
  );
  addSearchItems(
    store,
    indexes,
    "space.videos",
    content.searches.video.collection.items,
    content.assetCollections,
  );
}

function addSearchItems(
  store: MediaStore,
  indexes: StoreIndexes,
  collectionName: string,
  items: NasaSearchItemLike[],
  assetCollections: Record<string, string[]>,
): void {
  for (const item of items) {
    if (item === null) continue;
    addItemAssets(store, indexes, collectionName, item, assetCollections);
  }
}

function addItemAssets(
  store: MediaStore,
  indexes: StoreIndexes,
  collectionName: string,
  item: NasaSearchItemLike,
  assetCollections: Record<string, string[]>,
): void {
  const data = item.data[0];
  if (!data) return;
  const dataResult = NasaSearchItemDataLike.safeParse(data);
  if (!dataResult.success) {
    throw new Error(`Invalid NASA search item data: ${JSON.stringify(data)}`);
  }

  const collectionAssets = assetCollections[item.href] ?? [];
  let primaryUrl: string | null;
  if (data.media_type === "video") {
    primaryUrl = pickAssetUrl(collectionAssets, [
      "~orig.mp4",
      "~large.mp4",
      "~medium.mp4",
      "~mobile.mp4",
    ]);
  } else {
    primaryUrl = pickAssetUrl(collectionAssets, ["~orig.jpg", "~large.jpg", "~medium.jpg"]);
  }

  if (primaryUrl == null) {
    throw new Error(`No primary asset URL found for NASA search item: ${JSON.stringify(data)}`);
  }

  let posterUrl = pickAssetUrl(collectionAssets, [
    "~thumb.jpg",
    "~small.jpg",
    "~medium.jpg",
    "~large.jpg",
  ]);
  if (posterUrl == null) {
    const posterLink = item.links.find((link) => link.render === "image");
    if (posterLink == null) {
      throw new Error(`No poster link found for NASA search item: ${JSON.stringify(data)}`);
    }
    posterUrl = posterLink.href;
  }

  const metadata = {
    title: data.title,
    description: data.description,
    summary: `From NASA Images API item ${data.nasa_id} (${data.center}).`,
    center: data.center,
    dateCreated: data.date_created,
    keywords: data.keywords ?? [],
    nasaId: data.nasa_id,
    sourceItem: item.href,
  };

  const version = `${data.nasa_id}-${data.date_created.slice(0, 10)}`;
  const primaryMime = data.media_type === "video" ? "video/mp4" : "image/jpeg";

  store.add([collectionName, data.nasa_id, "primary"], {
    version,
    mimeType: primaryMime,
    url: primaryUrl,
    metadata,
    indexes: [
      indexes.collection(collectionName),
      indexes.mediaType(data.media_type),
      indexes.role("primary"),
    ],
  });

  store.add([collectionName, data.nasa_id, "poster"], {
    version,
    mimeType: "image/jpeg",
    url: posterUrl,
    metadata,
    indexes: [
      indexes.collection(collectionName),
      indexes.mediaType(data.media_type),
      indexes.role("poster"),
    ],
  });
}

/** Picks the best asset URL from a list of URLs and preferred suffixes */
function pickAssetUrl(assetUrls: string[], preferredSuffixes: string[]): string | null {
  for (const suffix of preferredSuffixes) {
    const match = assetUrls.find((url) => url.endsWith(suffix));
    if (match) return match;
  }
  return null;
}
