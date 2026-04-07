/**
 * NASA Images API → Offline Manifest Transformations
 *
 * This file turns raw NASA Images search results into the manifest format
 * expected by `electron-offline-content`. It handles:
 *
 * - Validating the NASA search response with Zod schemas
 * - Resolving the best available asset URL (video or image) from each
 *   item's collection, preferring higher-quality variants first
 * - Attaching a poster/thumbnail asset for each item
 * - Producing fully-formed manifest items ready for offline caching
 *
 * Used by the NASA example app's content producer.
 */
import {
  defineAsset,
  defineItem,
  itemsFromEntries,
  type MediaItemValue,
} from "@rockhallweb/electron-offline-content/main";
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

/** Transforms a NASA search item into a manifest item [id, value] entry */
function toManifestItemEntry(
  item: NasaSearchItemLike,
  assetCollections: Record<string, string[]>,
): [string, MediaItemValue] {
  // NASA search payload gives metadata; collection.json gives concrete downloadable asset URLs.
  const data = item.data[0];
  const dataResult = NasaSearchItemDataLike.safeParse(data);
  if (!dataResult.success) {
    throw new Error(`Invalid NASA search item data: ${JSON.stringify(data)}`);
  }

  const collectionAssets = assetCollections[item.href] ?? [];
  let primaryAssetUrl: string | null;
  if (data.media_type === "video") {
    primaryAssetUrl = pickAssetUrl(collectionAssets, [
      "~orig.mp4",
      "~large.mp4",
      "~medium.mp4",
      "~mobile.mp4",
    ]);
  } else {
    primaryAssetUrl = pickAssetUrl(collectionAssets, ["~orig.jpg", "~large.jpg", "~medium.jpg"]);
  }

  if (primaryAssetUrl == null) {
    throw new Error(`No primary asset URL found for NASA search item: ${JSON.stringify(data)}`);
  }

  let posterAssetUrl = pickAssetUrl(collectionAssets, [
    "~thumb.jpg",
    "~small.jpg",
    "~medium.jpg",
    "~large.jpg",
  ]);
  if (posterAssetUrl == null) {
    const posterLink = item.links.find((link) => link.render === "image");
    if (posterLink == null) {
      throw new Error(`No poster link found for NASA search item: ${JSON.stringify(data)}`);
    }
    posterAssetUrl = posterLink.href;
  }

  const assets = {
    main: defineAsset({
      role: "primary",
      kind: data.media_type,
      source: { url: primaryAssetUrl },
    }),
    poster: defineAsset({
      role: "poster",
      kind: "poster",
      source: { url: posterAssetUrl },
    }),
  };

  return [
    data.nasa_id,
    defineItem({
      version: `${data.nasa_id}-${data.date_created.slice(0, 10)}`,
      kind: data.media_type,
      title: data.title,
      description: data.description,
      summary: `From NASA Images API item ${data.nasa_id} (${data.center}).`,
      blobs: {
        sourceItem: item.href,
      },
      metadata: {
        center: data.center,
        dateCreated: data.date_created,
        keywords: data.keywords ?? [],
      },
      assets,
    }),
  ];
}

/** Picks the best asset URL from a list of URLs and preferred suffixes */
function pickAssetUrl(assetUrls: string[], preferredSuffixes: string[]): string | null {
  return assetUrls.find((url) => preferredSuffixes.some((suffix) => url.endsWith(suffix))) ?? null;
}

/** Transforms NASA search items into a manifest `items` record */
export function getManifestItems(
  assetCollections: NasaContentSchema["assetCollections"],
  items: NasaSearchItemLike[],
) {
  return itemsFromEntries(
    items.filter((item) => item !== null),
    (item) => toManifestItemEntry(item, assetCollections),
  );
}
