/**
 * The slice of the Immich API (v3.2+) this server reads. Field names match
 * Immich's OpenAPI document (`GET /api/spec.json`); everything not used here
 * is left out rather than typed loosely.
 */

export type AssetType = "IMAGE" | "VIDEO" | "AUDIO" | "OTHER";
export type AssetVisibility = "archive" | "timeline" | "hidden" | "locked";

export interface ExifInfo {
  make?: string | null;
  model?: string | null;
  lensModel?: string | null;
  exifImageWidth?: number | null;
  exifImageHeight?: number | null;
  fileSizeInByte?: number | null;
  dateTimeOriginal?: string | null;
  timeZone?: string | null;
  fNumber?: number | null;
  focalLength?: number | null;
  iso?: number | null;
  exposureTime?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  description?: string | null;
  rating?: number | null;
}

export interface PersonRef {
  id: string;
  name: string;
  isHidden?: boolean;
  birthDate?: string | null;
  isFavorite?: boolean;
}

export interface TagRef {
  id: string;
  name: string;
  value?: string;
}

export interface Asset {
  id: string;
  type: AssetType;
  originalFileName: string;
  /** Where the file lives on the server, e.g. `/data/library/ada/2024/IMG_0001.jpg`. */
  originalPath?: string;
  originalMimeType?: string;
  /** Wall-clock time where the photo was taken, serialized with a misleading `Z`. */
  localDateTime: string;
  /** The capture instant in UTC. */
  fileCreatedAt: string;
  width?: number | null;
  height?: number | null;
  /** Milliseconds, for videos. */
  duration?: number | null;
  isFavorite: boolean;
  isArchived?: boolean;
  isTrashed?: boolean;
  visibility: AssetVisibility;
  livePhotoVideoId?: string | null;
  exifInfo?: ExifInfo;
  people?: PersonRef[];
  tags?: TagRef[];
}

export interface SearchAssetPage {
  /** For smart search this is the page size, not the size of the result set. */
  total: number;
  count: number;
  items: Asset[];
  /** Smart search: the next `page` number. */
  nextPage: string | null;
  /** Metadata search: opaque cursor for the next page. */
  nextCursor?: string | null;
}

export interface SearchResponse {
  assets: SearchAssetPage;
}

export interface OcrLine {
  id: string;
  assetId: string;
  text: string;
  textScore: number;
  boxScore: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  x4: number;
  y4: number;
}

export interface Album {
  id: string;
  albumName: string;
  description?: string;
  assetCount: number;
  startDate?: string | null;
  endDate?: string | null;
  shared: boolean;
}

export interface PeoplePage {
  total: number;
  hidden: number;
  hasNextPage: boolean;
  people: PersonRef[];
}

export type SuggestionType =
  | "country"
  | "state"
  | "city"
  | "camera-make"
  | "camera-model"
  | "camera-lens-model";

export type ThumbnailSize = "thumbnail" | "preview";

export interface ImageBytes {
  mimeType: string;
  data: Uint8Array;
}

// --- Request filter (the v3.2 `filter` object shared by every search endpoint) ---

export interface IdsFilter {
  any?: string[];
  all?: string[];
  none?: string[];
}

export interface DateFilter {
  gte?: string;
  gt?: string;
  lt?: string;
  lte?: string;
}

export interface SearchFilter {
  type?: { eq?: AssetType; in?: AssetType[] };
  visibility?: { in: AssetVisibility[] };
  isFavorite?: { eq: boolean };
  hasTags?: { eq: boolean };
  city?: { in: string[] };
  state?: { in: string[] };
  country?: { in: string[] };
  make?: { in: string[] };
  model?: { in: string[] };
  lensModel?: { in: string[] };
  /** `eq: null` means unrated. */
  rating?: { eq?: number | null; gte?: number };
  ocr?: { matches: string };
  description?: { like: string };
  originalFileName?: { like: string };
  originalPath?: { like: string };
  personIds?: IdsFilter;
  albumIds?: IdsFilter;
  tagIds?: IdsFilter;
  takenAt?: DateFilter;
}

export type SearchOrderField = "fileCreatedAt" | "localDateTime" | "fileSizeInBytes" | "rating";

export interface SmartSearchRequest {
  query: string;
  size: number;
  filter?: SearchFilter;
  withExif?: boolean;
  language?: string;
}

export interface MetadataSearchRequest {
  size: number;
  cursor?: string;
  filter?: SearchFilter;
  orderBy?: { field: SearchOrderField; direction: "asc" | "desc" };
  withExif?: boolean;
  withPeople?: boolean;
}

/** `GET /api-keys/me`. `permissions` holds Immich permission names, or `all`. */
export interface ApiKeyInfo {
  id: string;
  name: string;
  permissions: string[];
}

/** `GET /tags`. `value` is the full path ("Travel/2024"); `name` is its last part. */
export interface Tag {
  id: string;
  name: string;
  value: string;
  parentId?: string | null;
}
