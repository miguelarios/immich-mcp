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
  path?: string;
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
      'Find photos and videos by what they LOOK like, from a description in plain words (Immich\'s "Context" search): ' +
      '"sunrise on the beach", "kids blowing out birthday candles", "a red car in the snow". ' +
      "Use it whenever the user describes a scene, an object or an activity, even loosely. " +
      "It understands what is visible, not who people are or where and when a photo was taken: put names, places, " +
      "dates, cameras, tags and ratings in the filters, which narrow the search before it ranks. " +
      "Results come best match first in one page, and there is always a best match even when nothing really fits, " +
      "so look at the top results with view_photo before presenting them; for more, raise limit or tighten the filters. " +
      "Use search_photo_text instead for words written IN the image (a receipt, a sign, a screenshot), and " +
      "search_photo_metadata when the user gives only facts (who, where, when, album, file name) and no description.",
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
      "Find photos by words written IN the image, as read by Immich's OCR: receipts, signs, menus, whiteboards, " +
      'documents, screenshots, labels, license plates. Example: text "check out receipt" or "wifi password". ' +
      "Use it when the user remembers what a photo SAYS rather than what it shows. " +
      "Matching tolerates OCR misreadings, and each result carries the lines that matched so you can see why; " +
      "get_photo returns all the text of one photo. Newest first, paged with cursor. " +
      "Use search_photos instead when the user describes how the photo looks, and search_photo_metadata for " +
      "its file name or the description someone typed on it in Immich (neither is text in the image).",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description:
            'Words that appear in the image, e.g. "boarding pass" or a store name. A few distinctive words work better than a sentence.',
        },
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
      "List photos by FACTS about them rather than by how they look: who is in them, where and when they were taken, " +
      "with which camera, album, tags, star rating, file name, folder, or the description typed on them in Immich. " +
      "Use it when the user names facts and describes nothing to see: " +
      '"every photo of Ada from June 2024", "videos taken in Cancún", "my 5-star photos", "everything still untagged", ' +
      '"IMG_1234", "what is in the 2019/Japan folder", or to browse a date range. ' +
      "It returns everything that matches, newest first unless sort is oldest, paged with cursor, with the total count; " +
      "nothing is ranked. All arguments are optional, but give at least one. " +
      "Use search_photos instead as soon as the user describes what the photo shows (the same filters apply there), " +
      "and search_photo_text for words written in the image.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        fileName: {
          type: "string",
          minLength: 1,
          description:
            'Part of the original file name or its extension, e.g. "IMG_1234", "IMG_1234.JPG" or ".png".',
        },
        path: {
          type: "string",
          minLength: 1,
          description:
            'Part of the folder or full path the file is stored under on the server, e.g. "2019/Japan" or "/Camera Roll/". ' +
            "For a folder of imported photos; get_photo shows a photo's path.",
        },
        description: {
          type: "string",
          minLength: 1,
          description:
            'Part of the description (caption) typed on the photo in Immich, e.g. "birthday". Not text that appears in the image.',
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
      "Everything known about one photo or video from a search result: when (local and UTC) and where (place and " +
      "coordinates) it was taken, camera and lens, star rating, people, albums, tags, description, file path, and all " +
      "the text OCR read from it. Use it to answer a question about one photo; to SEE the photo use view_photo.",
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
