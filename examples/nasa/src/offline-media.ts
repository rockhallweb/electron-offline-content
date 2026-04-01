/**
 * Example manifest for `createMediaCache({ resolveManifest })`. Replace with your own
 * fetch or file read; shape must match `MediaCacheManifest` from the package.
 */
import { createMediaCache, defineManifest } from "@rockhallweb/electron-offline-content/main";
import { NasaContentSchema, getManifestItems } from "./transformations.js";

// Create the media cache for offline content
export const mediaCache = createMediaCache({
  devPassthrough: false,
  storagePath: {
    appPath: "temp",
    segments: ["rockhallweb-electron-offline-content-example", "nasa"],
  },
  resolveManifest: async () => {
    // Fetch NASA content (we're using a mock here)
    const nasaContent = await fetchNasaContent();

    // Validate and transform the NASA content
    const { data: nasaContentResult, success, error } = NasaContentSchema.safeParse(nasaContent);
    if (!success) {
      throw new Error(`Invalid NASA content: ${JSON.stringify(error)}`);
    }

    // Build the manifest
    return defineManifest({
      retrievedAt: new Date().toISOString(), // Optional: Set the retrieved at timestamp (mocked for demo purposes)
      namespaces: [
        {
          key: "space.images",
          label: "NASA Images API - Images",
          metadata: {
            requestUrl: nasaContentResult.searches.image.collection.href,
          },
          items: getManifestItems(
            nasaContentResult.assetCollections,
            nasaContentResult.searches.image.collection.items,
          ),
        },
        {
          key: "space.videos",
          label: "NASA Images API - Videos",
          metadata: {
            requestUrl: nasaContentResult.searches.video.collection.href,
          },
          items: getManifestItems(
            nasaContentResult.assetCollections,
            nasaContentResult.searches.video.collection.items,
          ),
        },
      ],
    });
  },
});

/** Returns a mock NASA content fixture */
async function fetchNasaContent() {
  const fetchedContent = {
    searches: {
      image: {
        // Real request: https://images-api.nasa.gov/search?q=moon%20tree&media_type=image
        collection: {
          href: "http://images-api.nasa.gov/search?q=moon%20tree&media_type=image",
          items: [
            {
              href: "https://images-assets.nasa.gov/image/SSC-20110203-S00095H/collection.json",
              data: [
                {
                  center: "SSC",
                  date_created: "2011-02-03T00:00:00Z",
                  description:
                    "Apollo 13 astronaut Fred Haise stands with Rosemary Roosa, daughter of late Apollo 14 astronaut Stuart Roosa, beside a 'moon tree' planted at the INFINITY science center on Feb. 3, 2011. The moon tree is a descendent of seeds carried into space by Stuart Roosa on the Apollo 14 mission in 1971.",
                  keywords: ["Moon tree; INFINITY; planting ceremony; Apollo 14; Fred Haise"],
                  media_type: "image",
                  nasa_id: "SSC-20110203-S00095H",
                  title: "Moon tree ceremony",
                },
              ],
              links: [
                {
                  href: "https://images-assets.nasa.gov/image/SSC-20110203-S00095H/SSC-20110203-S00095H~medium.jpg",
                  rel: "alternate",
                  render: "image",
                },
              ],
            },
            {
              href: "https://images-assets.nasa.gov/image/jsc2007e034221/collection.json",
              data: [
                {
                  center: "JSC",
                  date_created: "1969-07-11T00:00:00Z",
                  description:
                    "Personnel atop the 402-ft. Mobile Service Structure look back at the Apollo 11 spacecraft as the tower is moved away during a Countdown Demonstration Test.",
                  keywords: ["Apollo 11", "Saturn V", "Kennedy Space Center", "launch prep"],
                  media_type: "image",
                  nasa_id: "jsc2007e034221",
                  title: "Apollo 11 spacecraft pre-launch",
                },
              ],
              links: [
                {
                  href: "https://images-assets.nasa.gov/image/jsc2007e034221/jsc2007e034221~medium.jpg",
                  rel: "alternate",
                  render: "image",
                },
              ],
            },
            {
              href: "https://images-assets.nasa.gov/image/PIA07081/collection.json",
              data: [
                {
                  center: "JPL",
                  date_created: "2004-11-30T21:29:24Z",
                  description: "Mars Rover Studies Soil on Mars.",
                  keywords: ["Mars", "Rover", "Soil", "Exploration", "JPL"],
                  media_type: "image",
                  nasa_id: "PIA07081",
                  title: "Mars Rover Studies Soil on Mars",
                },
              ],
              links: [
                {
                  href: "https://images-assets.nasa.gov/image/PIA07081/PIA07081~small.jpg",
                  rel: "alternate",
                  render: "image",
                },
              ],
            },
            {
              href: "https://images-assets.nasa.gov/image/PIA12110/collection.json",
              data: [
                {
                  center: "STScI (Hubble)",
                  date_created: "1996-01-15T18:46:16Z",
                  description:
                    "Several hundred never-before-seen galaxies are visible in this deepest-ever view of the universe, called the Hubble Deep Field.",
                  keywords: ["Hubble", "Deep Field", "Galaxies", "Cosmology"],
                  media_type: "image",
                  nasa_id: "PIA12110",
                  title:
                    "Hubble Deep Field Image Unveils Myriad Galaxies Back to the Beginning of Time",
                },
              ],
              links: [
                {
                  href: "https://images-assets.nasa.gov/image/PIA12110/PIA12110~medium.jpg",
                  rel: "alternate",
                  render: "image",
                },
              ],
            },
            {
              href: "https://images-assets.nasa.gov/image/NHQ201907190146/collection.json",
              data: [
                {
                  center: "HQ",
                  date_created: "2019-07-19T00:00:00Z",
                  description:
                    "A visitor learns about circuits at the Apollo 11 50th Anniversary celebration on the National Mall in Washington.",
                  keywords: ["Apollo 11", "Anniversary", "NASA HQ", "National Mall"],
                  media_type: "image",
                  nasa_id: "NHQ201907190146",
                  title: "Apollo 11 50th Anniversary Celebration",
                },
              ],
              links: [
                {
                  href: "https://images-assets.nasa.gov/image/NHQ201907190146/NHQ201907190146~medium.jpg",
                  rel: "alternate",
                  render: "image",
                },
              ],
            },
          ],
        },
      },
      video: {
        // Real request: https://images-api.nasa.gov/search?q=moon%20tree&media_type=video
        collection: {
          href: "http://images-api.nasa.gov/search?q=moon%20tree&media_type=video",
          items: [
            {
              href: "https://images-assets.nasa.gov/video/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209/collection.json",
              data: [
                {
                  center: "JSC",
                  date_created: "2024-02-09T00:00:00Z",
                  description:
                    "Aboard the International Space Station, NASA Expedition 70 Flight Engineer Loral O'Hara and ESA astronaut Andy Mogensen discussed living and working in space during an in-flight event with students in Massachusetts.",
                  keywords: [
                    "Expedition 70",
                    "Loral O'Hara",
                    "Andy Mogensen",
                    "International Space Station",
                  ],
                  media_type: "video",
                  nasa_id:
                    "iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209",
                  title: "Expedition 70 Space Station Crew Answers Massachusetts Student Questions",
                },
              ],
              links: [
                {
                  href: "https://images-assets.nasa.gov/video/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209~thumb.jpg",
                  rel: "preview",
                  render: "image",
                },
              ],
            },
            {
              href: "https://images-assets.nasa.gov/video/GRC-2016-CM-0129.2/collection.json",
              data: [
                {
                  center: "GRC",
                  date_created: "2023-02-17T00:00:00Z",
                  description:
                    "Researchers discuss environmental control systems and science operations aboard the International Space Station.",
                  keywords: ["ISS", "Environmental Control", "NASA Glenn", "Microgravity Research"],
                  media_type: "video",
                  nasa_id: "GRC-2016-CM-0129.2",
                  title: "Environmental Control Systems on the International Space Station (ISS)",
                },
              ],
              links: [
                {
                  href: "https://images-assets.nasa.gov/video/GRC-2016-CM-0129.2/GRC-2016-CM-0129.2~large.jpg",
                  rel: "preview",
                  render: "image",
                },
              ],
            },
            {
              href: "https://images-assets.nasa.gov/video/A1Launch/collection.json",
              data: [
                {
                  center: "MSFC",
                  date_created: "2022-12-08T00:00:00Z",
                  description:
                    "A collage of multiple camera views from the Artemis I launch at Kennedy Space Center.",
                  keywords: ["Artemis I", "SLS", "Launch", "Kennedy Space Center"],
                  media_type: "video",
                  nasa_id: "A1Launch",
                  title: "Artemis I Launch Collage",
                },
              ],
              links: [
                {
                  href: "https://images-assets.nasa.gov/video/A1Launch/A1Launch~large.jpg",
                  rel: "preview",
                  render: "image",
                },
              ],
            },
          ],
        },
      },
    },
    assetCollections: {
      // Real request:
      // https://images-assets.nasa.gov/image/SSC-20110203-S00095H/collection.json
      "https://images-assets.nasa.gov/image/SSC-20110203-S00095H/collection.json": [
        "http://images-assets.nasa.gov/image/SSC-20110203-S00095H/SSC-20110203-S00095H~orig.jpg",
        "http://images-assets.nasa.gov/image/SSC-20110203-S00095H/SSC-20110203-S00095H~large.jpg",
        "http://images-assets.nasa.gov/image/SSC-20110203-S00095H/SSC-20110203-S00095H~medium.jpg",
        "http://images-assets.nasa.gov/image/SSC-20110203-S00095H/SSC-20110203-S00095H~small.jpg",
        "http://images-assets.nasa.gov/image/SSC-20110203-S00095H/SSC-20110203-S00095H~thumb.jpg",
      ],
      "https://images-assets.nasa.gov/image/jsc2007e034221/collection.json": [
        "http://images-assets.nasa.gov/image/jsc2007e034221/jsc2007e034221~orig.jpg",
        "http://images-assets.nasa.gov/image/jsc2007e034221/jsc2007e034221~large.jpg",
        "http://images-assets.nasa.gov/image/jsc2007e034221/jsc2007e034221~medium.jpg",
        "http://images-assets.nasa.gov/image/jsc2007e034221/jsc2007e034221~thumb.jpg",
      ],
      "https://images-assets.nasa.gov/image/PIA07081/collection.json": [
        "http://images-assets.nasa.gov/image/PIA07081/PIA07081~orig.jpg",
        "http://images-assets.nasa.gov/image/PIA07081/PIA07081~small.jpg",
        "http://images-assets.nasa.gov/image/PIA07081/PIA07081~thumb.jpg",
      ],
      "https://images-assets.nasa.gov/image/PIA12110/collection.json": [
        "http://images-assets.nasa.gov/image/PIA12110/PIA12110~orig.jpg",
        "http://images-assets.nasa.gov/image/PIA12110/PIA12110~medium.jpg",
        "http://images-assets.nasa.gov/image/PIA12110/PIA12110~thumb.jpg",
      ],
      "https://images-assets.nasa.gov/image/NHQ201907190146/collection.json": [
        "http://images-assets.nasa.gov/image/NHQ201907190146/NHQ201907190146~large.jpg",
        "http://images-assets.nasa.gov/image/NHQ201907190146/NHQ201907190146~medium.jpg",
        "http://images-assets.nasa.gov/image/NHQ201907190146/NHQ201907190146~thumb.jpg",
      ],
      // Real request:
      // https://images-assets.nasa.gov/video/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209/collection.json
      "https://images-assets.nasa.gov/video/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209/collection.json":
        [
          "http://images-assets.nasa.gov/video/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209~orig.mp4",
          "http://images-assets.nasa.gov/video/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209~large.mp4",
          "http://images-assets.nasa.gov/video/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209~medium.mp4",
          "http://images-assets.nasa.gov/video/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209~mobile.mp4",
          "http://images-assets.nasa.gov/video/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209~thumb.jpg",
          "http://images-assets.nasa.gov/video/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209/iss070m260401848_Expedition_70_Space_Station_Crew_Answers_Massachusetts_Student_Questions_240209~medium.jpg",
        ],
      "https://images-assets.nasa.gov/video/GRC-2016-CM-0129.2/collection.json": [
        "http://images-assets.nasa.gov/video/GRC-2016-CM-0129.2/GRC-2016-CM-0129.2~orig.mp4",
        "http://images-assets.nasa.gov/video/GRC-2016-CM-0129.2/GRC-2016-CM-0129.2~large.mp4",
        "http://images-assets.nasa.gov/video/GRC-2016-CM-0129.2/GRC-2016-CM-0129.2~medium.mp4",
        "http://images-assets.nasa.gov/video/GRC-2016-CM-0129.2/GRC-2016-CM-0129.2~mobile.mp4",
        "http://images-assets.nasa.gov/video/GRC-2016-CM-0129.2/GRC-2016-CM-0129.2~thumb.jpg",
        "http://images-assets.nasa.gov/video/GRC-2016-CM-0129.2/GRC-2016-CM-0129.2~medium.jpg",
      ],
      "https://images-assets.nasa.gov/video/A1Launch/collection.json": [
        "http://images-assets.nasa.gov/video/A1Launch/A1Launch~orig.mp4",
        "http://images-assets.nasa.gov/video/A1Launch/A1Launch~large.mp4",
        "http://images-assets.nasa.gov/video/A1Launch/A1Launch~medium.mp4",
        "http://images-assets.nasa.gov/video/A1Launch/A1Launch~mobile.mp4",
        "http://images-assets.nasa.gov/video/A1Launch/A1Launch~thumb.jpg",
        "http://images-assets.nasa.gov/video/A1Launch/A1Launch~medium.jpg",
      ],
    },
  };

  // Cast to simulate uncontrolled content shape
  return fetchedContent as unknown;
}
