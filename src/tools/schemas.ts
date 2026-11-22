/**
 * Output schemas (valibot). The SDK validates every `structuredContent`
 * against these before it leaves the server, so a shape drift in Immich's
 * responses surfaces as a tool error rather than as a silently wrong answer.
 */
import * as v from "valibot";

export const photoSummarySchema = v.object({
  id: v.string(),
  type: v.picklist(["photo", "video", "other"]),
  takenAt: v.string(),
  fileName: v.string(),
  location: v.optional(v.string()),
  description: v.optional(v.string()),
  people: v.optional(v.array(v.string())),
  isFavorite: v.boolean(),
  durationSeconds: v.optional(v.number()),
  url: v.string(),
});

const appliedSchema = v.object({
  people: v.optional(v.array(v.object({ id: v.string(), name: v.string() }))),
  album: v.optional(v.object({ id: v.string(), name: v.string() })),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  country: v.optional(v.string()),
  takenAt: v.optional(
    v.object({
      gte: v.optional(v.string()),
      lt: v.optional(v.string()),
      lte: v.optional(v.string()),
    }),
  ),
  cameraMake: v.optional(v.string()),
  cameraModel: v.optional(v.string()),
  lens: v.optional(v.string()),
  tags: v.optional(v.array(v.object({ id: v.string(), name: v.string() }))),
  untagged: v.optional(v.boolean()),
  minRating: v.optional(v.number()),
  unrated: v.optional(v.boolean()),
  mediaType: v.optional(v.picklist(["photo", "video"])),
  favoritesOnly: v.optional(v.boolean()),
  includeArchived: v.optional(v.boolean()),
});

export const contextResultSchema = v.object({
  photos: v.array(photoSummarySchema),
  count: v.number(),
  applied: appliedSchema,
});

export const textResultSchema = v.object({
  photos: v.array(
    v.object({ ...photoSummarySchema.entries, matchedText: v.optional(v.array(v.string())) }),
  ),
  count: v.number(),
  total: v.number(),
  nextCursor: v.nullable(v.string()),
  applied: appliedSchema,
});

export const metadataResultSchema = v.object({
  photos: v.array(photoSummarySchema),
  count: v.number(),
  total: v.number(),
  nextCursor: v.nullable(v.string()),
  applied: appliedSchema,
});

export const photoDetailSchema = v.object({
  ...photoSummarySchema.entries,
  takenAtUtc: v.string(),
  timeZone: v.optional(v.string()),
  coordinates: v.optional(v.object({ latitude: v.number(), longitude: v.number() })),
  camera: v.optional(v.string()),
  lens: v.optional(v.string()),
  dimensions: v.optional(v.string()),
  fileSizeBytes: v.optional(v.number()),
  mimeType: v.optional(v.string()),
  rating: v.optional(v.number()),
  albums: v.array(v.string()),
  tags: v.array(v.string()),
  isArchived: v.boolean(),
  text: v.optional(v.string()),
});

export const peopleResultSchema = v.object({
  people: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      birthDate: v.optional(v.string()),
      isFavorite: v.optional(v.boolean()),
    }),
  ),
  count: v.number(),
  nextPage: v.nullable(v.number()),
});

export const albumsResultSchema = v.object({
  albums: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      photoCount: v.number(),
      from: v.optional(v.string()),
      to: v.optional(v.string()),
      description: v.optional(v.string()),
      shared: v.boolean(),
      url: v.string(),
    }),
  ),
  count: v.number(),
});

export const tagsResultSchema = v.object({
  tags: v.array(v.object({ id: v.string(), name: v.string() })),
  count: v.number(),
});

export const camerasResultSchema = v.object({
  makes: v.array(v.string()),
  models: v.array(v.string()),
  lenses: v.array(v.string()),
});
