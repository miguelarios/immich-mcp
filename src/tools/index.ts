import type { CommonFilters, PhotoLibrary } from "../library/PhotoLibrary.js";
import { READ_ONLY, type ToolDef, structured, toolError } from "../mcp/tools.js";
import {
  albumsResultSchema,
  camerasResultSchema,
  contextResultSchema,
  metadataResultSchema,
  peopleResultSchema,
  photoDetailSchema,
  tagsResultSchema,
  textResultSchema,
} from "./schemas.js";

const NAME = (description: string) => ({ type: "string", minLength: 1, description }) as const;

/** A calendar period (a year, a month, a day) or a full timestamp. Anything else is refused. */
const DATE_PATTERN =
  "^\\d{4}(-\\d{2}(-\\d{2}(T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})?)?)?)?$";
const DATE = (description: string) =>
  ({ type: "string", pattern: DATE_PATTERN, description }) as const;

/**
 * Filters shared by every search tool, grouped like the sections of Immich's
 * own filter panel. Names are resolved server-side against what the library
 * has, so a value need not match Immich's spelling, case or accents.
 */
const FILTER_PROPS = {
  people: {
    type: "array",
    items: { type: "string", minLength: 1 },
    maxItems: 10,
    description:
      'People who must ALL appear, by name as tagged in Immich (accent- and case-insensitive; a unique first name is enough, e.g. ["Ada"]) or by person id. Names: list_people.',
  },
  place: {
    type: "object",
    additionalProperties: false,
    description:
      "Where it was taken. Give any of the three; each narrows the others. Spelling, case and accents need not match.",
    properties: {
      city: NAME('City where it was taken, e.g. "Cancún".'),
      state: NAME('State, province or region where it was taken, e.g. "Texas".'),
      country: NAME('Country where it was taken, e.g. "Mexico".'),
    },
  },
  taken: {
    type: "object",
    additionalProperties: false,
    description:
      "When it was taken. Each end is a year (YYYY), a month (YYYY-MM), a day (YYYY-MM-DD) or a full ISO timestamp, " +
      'read in the library owner\'s time zone, and both ends include the whole period named: {"from": "2024-06", "to": "2024-06"} is all of June 2024.',
    properties: {
      from: DATE(
        'Taken on or after the start of this period, e.g. "2024", "2024-06", "2024-06-15".',
      ),
      to: DATE(
        'Taken on or before the end of this period: "2024" means through December 31, 2024.',
      ),
    },
  },
  camera: {
    type: "object",
    additionalProperties: false,
    description:
      "What it was taken with, as recorded in the photo's EXIF. Values the library has: list_cameras.",
    properties: {
      make: NAME('Camera maker, e.g. "Apple", "FUJIFILM".'),
      model: NAME('Camera model, e.g. "iPhone 15 Pro", "X-T5".'),
      lens: NAME('Lens model, e.g. "XF23mmF2 R WR".'),
    },
  },
  album: NAME("Only photos in this album (name or id). Names: list_albums."),
  tags: {
    type: "array",
    items: { type: "string", minLength: 1 },
    maxItems: 10,
    description:
      'Tags that must ALL be on the photo, by name ("Travel"), full path ("Travel/2024") or id. Names: list_tags. Not with untagged.',
  },
  untagged: {
    type: "boolean",
    description: "Only photos with no tag at all. Default false. Not with tags.",
  },
  minRating: {
    type: "integer",
    minimum: 1,
    maximum: 5,
    description: "At least this many stars (1-5): 5 is only 5-star photos. Not with unrated.",
  },
  unrated: {
    type: "boolean",
    description: "Only photos with no star rating. Default false. Not with minRating.",
  },
  mediaType: {
    type: "string",
    enum: ["photo", "video", "any"],
    description: "Restrict to photos or videos. Default any.",
  },
  favoritesOnly: { type: "boolean", description: "Only favorites. Default false." },
  includeArchived: {
    type: "boolean",
    description: "Also search archived items. Default false (timeline only, like the app).",
  },
} as const;

const LIMIT = (max: number, fallback: number) => ({
  type: "integer",
  minimum: 1,
  maximum: max,
  description: `How many results to return (1-${max}). Default ${fallback}.`,
});

const PHOTO_ID = {
  type: "string",
  pattern: "^[0-9a-fA-F-]{36}$",
  description: "Photo id from a search result.",
} as const;

type Filters = CommonFilters;

type ContextArgs = Filters & { query: string; limit?: number };
type TextArgs = Filters & { text: string; limit?: number; cursor?: string; includeText?: boolean };
type MetadataArgs = Filters & {
  fileName?: string;
  description?: string;
  limit?: number;
  cursor?: string;
  sort?: "newest" | "oldest";
};
type PhotoArgs = { id: string; includeText?: boolean };
type ViewArgs = { id: string; size?: "thumbnail" | "preview" };
type PeopleArgs = { name?: string; limit?: number; page?: number };
type AlbumArgs = { name?: string; limit?: number };
type TagArgs = { name?: string; limit?: number };
type CameraArgs = { make?: string };

export const PHOTO_TOOLS: ReadonlyArray<ToolDef<PhotoLibrary>> = [
  {
    name: "search_photos",
    title: "Search Photos by Context",
    description:
      "Find photos and videos by what they show, described in natural language (Immich smart search, CLIP): " +
      '"sunrise on the beach", "kids blowing out birthday candles", "red car in the snow". ' +
      "Results are ranked by visual similarity, best first, in a single page: for more, raise limit or narrow the filters. " +
      "Combine with the people, place, date, camera, tag and rating filters to narrow it down. " +
      "For words printed IN the image (signs, receipts, documents, screenshots) use search_photo_text instead.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description:
            'Describe the photo you want to find, as you would to a person: "children jumping on a trampoline", ' +
            '"a red car parked in the snow". Describe what is visible; names, places and dates go in the filters.',
        },
        ...FILTER_PROPS,
        limit: LIMIT(200, 20),
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: contextResultSchema,
    handler: async (args: ContextArgs, library) => {
      try {
        return structured(await library.searchByContext({ ...args, limit: args.limit ?? 20 }));
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "search_photo_text",
    title: "Search Photos by Text (OCR)",
    description:
      "Find photos by text that appears IN the image, read by Immich's OCR: receipts, signs, menus, whiteboards, " +
      'documents, screenshots, labels, license plates. Example: text "check out receipt" or "wifi password". ' +
      "Matching tolerates OCR misspellings. Each result includes the matching lines of text so you can see why it matched; " +
      "call get_photo for the full text of one photo.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, description: "Words that appear in the image." },
        ...FILTER_PROPS,
        includeText: {
          type: "boolean",
          description: "Attach the matching OCR lines to each result. Default true.",
        },
        limit: LIMIT(50, 20),
        cursor: { type: "string", minLength: 1, description: "nextCursor from the previous page." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    outputSchema: textResultSchema,
    handler: async (args: TextArgs, library) => {
      try {
        return structured(
          await library.searchByText({
            ...args,
            limit: args.limit ?? 20,
            includeText: args.includeText ?? true,
          }),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "search_photo_metadata",
    title: "Search Photos by Metadata",
    description:
      "List photos by facts rather than content: who is in them, where and when they were taken, with which camera, " +
      "album, tags, star rating, file name or the description written on them. Newest first unless sort is oldest. Use it for " +
      '"every photo of Ada from June 2024", "videos taken in Cancún", "my 5-star photos", "everything still untagged", ' +
      '"IMG_1234", or to browse a date range. ' +
      "All filters are optional, but give at least one.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        fileName: {
          type: "string",
          minLength: 1,
          description: 'Part of the original file name, e.g. "IMG_1234" or ".mov".',
        },
        description: {
          type: "string",
          minLength: 1,
          description: "Part of the description written on the photo in Immich.",
        },
        ...FILTER_PROPS,
        sort: { type: "string", enum: ["newest", "oldest"], description: "Default newest." },
        limit: LIMIT(100, 25),
        cursor: { type: "string", minLength: 1, description: "nextCursor from the previous page." },
      },
      additionalProperties: false,
    },
    outputSchema: metadataResultSchema,
    handler: async (args: MetadataArgs, library) => {
      try {
        return structured(await library.searchByMetadata({ ...args, limit: args.limit ?? 25 }));
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "get_photo",
    title: "Get Photo Details",
    description:
      "Everything known about one photo or video: when (local and UTC) and where (place and coordinates) it was taken, " +
      "camera, people, albums, tags, description, and all the text OCR read from it.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        id: PHOTO_ID,
        includeText: { type: "boolean", description: "Include the OCR text. Default true." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: photoDetailSchema,
    handler: async (args: PhotoArgs, library) => {
      try {
        return structured(await library.getPhoto(args.id, args.includeText ?? true));
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "view_photo",
    title: "View Photo",
    description:
      "Return the image itself so you can look at it: to check a search result is what the user meant, describe it, " +
      "or read something OCR missed. For a video this is its poster frame. " +
      'size "preview" (default, ~1440px) shows detail; "thumbnail" (~250px) is cheap for a quick look at several.',
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        id: PHOTO_ID,
        size: { type: "string", enum: ["preview", "thumbnail"], description: "Default preview." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args: ViewArgs, library) => {
      try {
        const { photo, image } = await library.viewPhoto(args.id, args.size ?? "preview");
        const caption = [photo.fileName, photo.takenAt, photo.location, photo.people?.join(", ")]
          .filter(Boolean)
          .join(" · ");
        return {
          content: [
            {
              type: "image",
              data: Buffer.from(image.data).toString("base64"),
              mimeType: image.mimeType,
            },
            { type: "text", text: `${caption}\n${photo.url}` },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "list_people",
    title: "List People",
    description:
      "Named people Immich recognizes by face, with their ids. Pass name to look someone up " +
      "(accent- and case-insensitive). Use it when a people filter reports no match or several.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Part of a name to look up." },
        limit: LIMIT(500, 100),
        page: { type: "integer", minimum: 1, description: "Page, from nextPage. Default 1." },
      },
      additionalProperties: false,
    },
    outputSchema: peopleResultSchema,
    handler: async (args: PeopleArgs, library) => {
      try {
        return structured(
          await library.listPeople({
            name: args.name,
            limit: args.limit ?? 100,
            page: args.page ?? 1,
          }),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "list_albums",
    title: "List Albums",
    description:
      "Albums with their photo counts and date ranges, most recent first. Pass name to filter. " +
      "Use an album's name or id as the album filter of any search.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Part of an album name." },
        limit: LIMIT(500, 100),
      },
      additionalProperties: false,
    },
    outputSchema: albumsResultSchema,
    handler: async (args: AlbumArgs, library) => {
      try {
        return structured(await library.findAlbums({ name: args.name, limit: args.limit ?? 100 }));
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "list_tags",
    title: "List Tags",
    description:
      'The tags in the library, as full paths (a nested tag reads "Travel/2024"). Pass name to filter. ' +
      "Use a tag's name or path as the tags filter of any search, when that filter reports no match or several.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Part of a tag name or path." },
        limit: LIMIT(500, 200),
      },
      additionalProperties: false,
    },
    outputSchema: tagsResultSchema,
    handler: async (args: TagArgs, library) => {
      try {
        return structured(await library.findTags({ name: args.name, limit: args.limit ?? 200 }));
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "list_cameras",
    title: "List Cameras and Lenses",
    description:
      "The camera makes, models and lenses the library has photos from, exactly as recorded. " +
      "Pass make to see only that maker's models. Use the values in the camera filter of any search.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        make: {
          type: "string",
          minLength: 1,
          description: 'Only this maker\'s models, e.g. "Apple".',
        },
      },
      additionalProperties: false,
    },
    outputSchema: camerasResultSchema,
    handler: async (args: CameraArgs, library) => {
      try {
        return structured(await library.listCameras({ make: args.make }));
      } catch (err) {
        return toolError(err);
      }
    },
  },
];
