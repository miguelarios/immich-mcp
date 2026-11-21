import type { CommonFilters, PhotoLibrary } from "../library/PhotoLibrary.js";
import { READ_ONLY, type ToolDef, structured, toolError } from "../mcp/tools.js";
import {
  albumsResultSchema,
  contextResultSchema,
  metadataResultSchema,
  peopleResultSchema,
  photoDetailSchema,
  textResultSchema,
} from "./schemas.js";

/** Filters shared by every search tool. Names are resolved server-side. */
const FILTER_PROPS = {
  people: {
    type: "array",
    items: { type: "string", minLength: 1 },
    maxItems: 10,
    description:
      'People who must ALL appear, by name as tagged in Immich (accent- and case-insensitive; a unique first name is enough, e.g. ["Ada"]) or by person id.',
  },
  album: { type: "string", minLength: 1, description: "Only photos in this album (name or id)." },
  city: { type: "string", minLength: 1, description: 'City where it was taken, e.g. "Cancún".' },
  state: { type: "string", minLength: 1, description: 'State or region, e.g. "Texas".' },
  country: { type: "string", minLength: 1, description: 'Country, e.g. "Mexico".' },
  takenFrom: {
    type: "string",
    description:
      "Taken on or after this date: YYYY, YYYY-MM, YYYY-MM-DD (local calendar) or an ISO timestamp.",
  },
  takenTo: {
    type: "string",
    description:
      "Taken on or before this date, inclusive of the whole period named: 2024 means through Dec 31, 2024.",
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

export const PHOTO_TOOLS: ReadonlyArray<ToolDef<PhotoLibrary>> = [
  {
    name: "search_photos",
    title: "Search Photos by Context",
    description:
      "Find photos and videos by what they show, described in natural language (Immich smart search, CLIP): " +
      '"sunrise on the beach", "kids blowing out birthday candles", "red car in the snow". ' +
      "Results are ranked by visual similarity, best first, in a single page: for more, raise limit or narrow the filters. " +
      "Combine with people, place and date filters to narrow it down. " +
      "For words printed IN the image (signs, receipts, documents, screenshots) use search_photo_text instead.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "What the photo shows." },
        ...FILTER_PROPS,
        limit: LIMIT(200, 20),
      },
      required: ["query"],
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
      "List photos by facts rather than content: who is in them, where and when they were taken, album, file name " +
      "or the description written on them. Newest first unless sort is oldest. Use it for " +
      '"every photo of Ada from June 2024", "videos taken in Cancún", "IMG_1234", or to browse a date range. ' +
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
];
