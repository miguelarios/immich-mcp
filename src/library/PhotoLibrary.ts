import { InputError, NotFoundError } from "../errors.js";
import type { ImmichClient } from "../immich/client.js";
import type {
  Album,
  Asset,
  AssetType,
  AssetVisibility,
  OcrLine,
  PersonRef,
  SearchFilter,
  SearchOrderField,
  SuggestionType,
  ThumbnailSize,
} from "../immich/types.js";
import { takenRange, wallClock } from "./dates.js";
import { containsPattern, fold, isUuid } from "./text.js";

/** The filters every search tool accepts, in the words a model uses. */
export interface CommonFilters {
  /** Names (or person ids) that must all appear in the photo. */
  people?: string[];
  /** Album name or id. */
  album?: string;
  city?: string;
  state?: string;
  country?: string;
  takenFrom?: string;
  takenTo?: string;
  mediaType?: "photo" | "video" | "any";
  favoritesOnly?: boolean;
  includeArchived?: boolean;
}

export interface PhotoSummary {
  id: string;
  type: "photo" | "video" | "other";
  /** Wall-clock time where it was taken, `YYYY-MM-DDTHH:mm:ss`, no zone. */
  takenAt: string;
  fileName: string;
  location?: string;
  description?: string;
  people?: string[];
  isFavorite: boolean;
  durationSeconds?: number;
  url: string;
}

/** What a search resolved the caller's names to, so the model can see what was matched. */
export interface AppliedFilters {
  people?: { id: string; name: string }[];
  album?: { id: string; name: string };
  city?: string;
  state?: string;
  country?: string;
  takenAt?: { gte?: string; lt?: string; lte?: string };
  mediaType?: "photo" | "video";
  favoritesOnly?: boolean;
  includeArchived?: boolean;
}

export interface LibraryOptions {
  publicUrl: string;
  timeZone: string;
  /** How long album and place lists are cached. */
  cacheTtlMs?: number;
}

interface Cached<T> {
  value: T;
  expires: number;
}

const OCR_CONCURRENCY = 8;

/**
 * The workflows behind the tools. It turns what a person would say ("photos of
 * Ada at the beach in Cancún, summer 2024") into Immich's filter language —
 * names to ids, places to the exact spelling Immich stored, dates to instants —
 * and shapes results into something a model can read without the 40-field
 * asset payload.
 */
export class PhotoLibrary {
  private readonly cacheTtlMs: number;
  private albums?: Cached<Album[]>;
  private readonly places = new Map<SuggestionType, Cached<string[]>>();

  constructor(
    readonly client: ImmichClient,
    private readonly options: LibraryOptions,
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  }

  get timeZone(): string {
    return this.options.timeZone;
  }

  // ----- resolution ---------------------------------------------------------

  async resolvePerson(ref: string): Promise<{ id: string; name: string }> {
    const value = ref.trim();
    if (!value) throw new InputError("A person name cannot be empty.");
    if (isUuid(value)) return { id: value, name: value };

    const matches = (await this.client.searchPeople(value)).filter(
      (person) => person.name && !person.isHidden,
    );
    if (matches.length === 0) {
      throw new NotFoundError(
        `No named person matches "${value}". Call list_people to see the names Immich knows.`,
      );
    }
    const wanted = fold(value);
    const exact = matches.filter((person) => fold(person.name) === wanted);
    if (exact.length >= 1) return pick(exact[0]);
    // "Jose" for "José Núñez": a unique match on the first name is what the user meant.
    const byFirst = matches.filter((person) => fold(person.name).split(" ")[0] === wanted);
    if (byFirst.length === 1) return pick(byFirst[0]);
    if (matches.length === 1) return pick(matches[0]);
    const names = matches.slice(0, 10).map((person) => person.name);
    throw new InputError(
      `"${value}" matches several people: ${names.join(", ")}. Pass the full name or the person id.`,
    );
  }

  async resolveAlbum(ref: string): Promise<{ id: string; name: string }> {
    const value = ref.trim();
    if (!value) throw new InputError("An album name cannot be empty.");
    const albums = await this.listAlbums();
    if (isUuid(value)) {
      const album = albums.find((entry) => entry.id === value);
      return { id: value, name: album?.albumName ?? value };
    }
    const wanted = fold(value);
    const exact = albums.filter((album) => fold(album.albumName) === wanted);
    if (exact.length >= 1) return { id: exact[0].id, name: exact[0].albumName };
    const partial = albums.filter((album) => fold(album.albumName).includes(wanted));
    if (partial.length === 1) return { id: partial[0].id, name: partial[0].albumName };
    if (partial.length > 1) {
      const names = partial.slice(0, 10).map((album) => album.albumName);
      throw new InputError(`"${value}" matches several albums: ${names.join(", ")}.`);
    }
    throw new NotFoundError(`No album is named "${value}". Call list_albums to see them.`);
  }

  /**
   * Immich filters places by exact, case-sensitive value, so "cancun" finds
   * nothing when it stored "Cancún". Resolve against the values it actually has.
   */
  async resolvePlace(kind: "city" | "state" | "country", ref: string): Promise<string> {
    const value = ref.trim();
    if (!value) throw new InputError(`${kind} cannot be empty.`);
    const known = await this.knownPlaces(kind);
    const wanted = fold(value);
    const exact = known.find((place) => fold(place) === wanted);
    if (exact) return exact;
    const close = known.filter((place) => fold(place).includes(wanted)).slice(0, 10);
    const hint = close.length > 0 ? ` Close matches: ${close.join(", ")}.` : "";
    throw new NotFoundError(`No photos have ${kind} "${value}".${hint}`);
  }

  async listAlbums(): Promise<Album[]> {
    const now = Date.now();
    if (!this.albums || this.albums.expires <= now) {
      this.albums = { value: await this.client.listAlbums(), expires: now + this.cacheTtlMs };
    }
    return this.albums.value;
  }

  private async knownPlaces(kind: SuggestionType): Promise<string[]> {
    const now = Date.now();
    const cached = this.places.get(kind);
    if (cached && cached.expires > now) return cached.value;
    const value = (await this.client.suggestions(kind)).filter(Boolean);
    this.places.set(kind, { value, expires: now + this.cacheTtlMs });
    return value;
  }

  /** Builds Immich's `filter` object and reports what each name resolved to. */
  async buildFilter(
    filters: CommonFilters,
  ): Promise<{ filter: SearchFilter; applied: AppliedFilters }> {
    const filter: SearchFilter = {};
    const applied: AppliedFilters = {};

    const [people, album, city, state, country] = await Promise.all([
      filters.people?.length
        ? Promise.all(filters.people.map((ref) => this.resolvePerson(ref)))
        : undefined,
      filters.album ? this.resolveAlbum(filters.album) : undefined,
      filters.city ? this.resolvePlace("city", filters.city) : undefined,
      filters.state ? this.resolvePlace("state", filters.state) : undefined,
      filters.country ? this.resolvePlace("country", filters.country) : undefined,
    ]);

    if (people) {
      // The same person given twice (by name and by id) counts once, keeping
      // the resolved name rather than the bare id.
      const byId = new Map<string, { id: string; name: string }>();
      for (const person of people) {
        const seen = byId.get(person.id);
        if (!seen || seen.name === seen.id) byId.set(person.id, person);
      }
      const unique = [...byId.values()];
      filter.personIds = { all: unique.map((person) => person.id) };
      applied.people = unique;
    }
    if (album) {
      filter.albumIds = { any: [album.id] };
      applied.album = album;
    }
    if (city) {
      filter.city = { eq: city };
      applied.city = city;
    }
    if (state) {
      filter.state = { eq: state };
      applied.state = state;
    }
    if (country) {
      filter.country = { eq: country };
      applied.country = country;
    }

    const taken = takenRange(filters.takenFrom, filters.takenTo, this.options.timeZone);
    if (taken) {
      filter.takenAt = taken;
      applied.takenAt = taken;
    }

    const mediaType = filters.mediaType ?? "any";
    if (mediaType !== "any") {
      filter.type = { eq: (mediaType === "video" ? "VIDEO" : "IMAGE") as AssetType };
      applied.mediaType = mediaType;
    }
    // Excludes stills from the AUDIO/OTHER bucket and, by visibility below, the
    // hidden video halves of Live Photos, which would otherwise show up as
    // duplicate "videos" of every match.
    if (mediaType === "any") filter.type = { in: ["IMAGE", "VIDEO"] };

    if (filters.favoritesOnly) {
      filter.isFavorite = { eq: true };
      applied.favoritesOnly = true;
    }

    const visibility: AssetVisibility[] = filters.includeArchived
      ? ["timeline", "archive"]
      : ["timeline"];
    filter.visibility = { in: visibility };
    if (filters.includeArchived) applied.includeArchived = true;

    return { filter, applied };
  }

  // ----- searches -----------------------------------------------------------

  /**
   * Smart search returns one ranked page: since Immich 3.2 the `filter` object
   * cannot be combined with the deprecated `page`, and smart search has no
   * cursor, so "more results" means a larger limit or narrower filters.
   */
  async searchByContext(args: { query: string; limit: number } & CommonFilters) {
    const query = args.query.trim();
    if (!query) throw new InputError("query cannot be empty.");
    const { filter, applied } = await this.buildFilter(args);
    const response = await this.client.smartSearch({
      query,
      size: args.limit,
      filter,
      withExif: true,
    });
    const page = response.assets;
    return {
      photos: page.items.map((asset) => this.summarize(asset)),
      count: page.count,
      applied,
    };
  }

  async searchByText(
    args: { text: string; limit: number; cursor?: string; includeText: boolean } & CommonFilters,
  ) {
    const text = args.text.trim();
    if (!text) throw new InputError("text cannot be empty.");
    const { filter, applied } = await this.buildFilter(args);
    filter.ocr = { matches: text };
    const response = await this.client.metadataSearch({
      size: args.limit,
      cursor: args.cursor,
      filter,
      withExif: true,
      withPeople: true,
    });
    const page = response.assets;
    const photos = page.items.map((asset) => this.summarize(asset));
    if (args.includeText) {
      const lines = await mapLimit(page.items, OCR_CONCURRENCY, (asset) =>
        this.client.getAssetOcr(asset.id).catch(() => [] as OcrLine[]),
      );
      photos.forEach((photo, index) => {
        (photo as PhotoSummary & { matchedText?: string[] }).matchedText = matchingLines(
          lines[index],
          text,
        );
      });
    }
    return {
      photos: photos as (PhotoSummary & { matchedText?: string[] })[],
      count: page.count,
      total: page.total,
      nextCursor: page.nextCursor || null,
      applied,
    };
  }

  async searchByMetadata(
    args: {
      fileName?: string;
      description?: string;
      limit: number;
      cursor?: string;
      sort?: "newest" | "oldest";
    } & CommonFilters,
  ) {
    const { filter, applied } = await this.buildFilter(args);
    if (args.fileName?.trim()) filter.originalFileName = { like: containsPattern(args.fileName) };
    if (args.description?.trim()) filter.description = { like: containsPattern(args.description) };
    const field: SearchOrderField = "fileCreatedAt";
    const response = await this.client.metadataSearch({
      size: args.limit,
      cursor: args.cursor,
      filter,
      orderBy: { field, direction: args.sort === "oldest" ? "asc" : "desc" },
      withExif: true,
      withPeople: true,
    });
    const page = response.assets;
    return {
      photos: page.items.map((asset) => this.summarize(asset)),
      count: page.count,
      total: page.total,
      nextCursor: page.nextCursor || null,
      applied,
    };
  }

  // ----- single photo -------------------------------------------------------

  async getPhoto(id: string, includeText: boolean) {
    if (!isUuid(id)) throw new InputError(`"${id}" is not a photo id (a UUID from a search).`);
    const [asset, albums, ocr] = await Promise.all([
      this.client.getAsset(id),
      this.client.getAlbumsForAsset(id).catch(() => [] as Album[]),
      includeText ? this.client.getAssetOcr(id).catch(() => [] as OcrLine[]) : undefined,
    ]);
    const exif = asset.exifInfo ?? {};
    const camera = [exif.make, exif.model].filter(Boolean).join(" ") || undefined;
    const coordinates =
      typeof exif.latitude === "number" && typeof exif.longitude === "number"
        ? { latitude: exif.latitude, longitude: exif.longitude }
        : undefined;
    const width = exif.exifImageWidth ?? asset.width ?? undefined;
    const height = exif.exifImageHeight ?? asset.height ?? undefined;
    return {
      ...this.summarize(asset),
      takenAtUtc: asset.fileCreatedAt,
      timeZone: exif.timeZone ?? undefined,
      ...(coordinates ? { coordinates } : {}),
      ...(camera ? { camera } : {}),
      ...(exif.lensModel ? { lens: exif.lensModel } : {}),
      ...(width && height ? { dimensions: `${width}x${height}` } : {}),
      ...(exif.fileSizeInByte ? { fileSizeBytes: exif.fileSizeInByte } : {}),
      ...(asset.originalMimeType ? { mimeType: asset.originalMimeType } : {}),
      ...(typeof exif.rating === "number" ? { rating: exif.rating } : {}),
      albums: albums.map((album) => album.albumName),
      tags: (asset.tags ?? []).map((tag) => tag.value ?? tag.name),
      isArchived: asset.visibility === "archive",
      ...(ocr ? { text: ocrText(ocr) } : {}),
    };
  }

  async viewPhoto(id: string, size: ThumbnailSize) {
    if (!isUuid(id)) throw new InputError(`"${id}" is not a photo id (a UUID from a search).`);
    const [asset, image] = await Promise.all([
      this.client.getAsset(id),
      this.client.thumbnail(id, size),
    ]);
    return { photo: this.summarize(asset), image };
  }

  // ----- browsing -----------------------------------------------------------

  async listPeople(args: { name?: string; limit: number; page: number }) {
    if (args.name?.trim()) {
      const people = (await this.client.searchPeople(args.name.trim()))
        .filter((person) => person.name && !person.isHidden)
        .slice(0, args.limit);
      return { people: people.map(personEntry), count: people.length, nextPage: null };
    }
    // Unnamed face clusters outnumber named people many times over and are
    // useless as a filter, so page through and keep only the named ones.
    const response = await this.client.listPeople(args.page, args.limit);
    const people = response.people.filter((person) => person.name && !person.isHidden);
    return {
      people: people.map(personEntry),
      count: people.length,
      nextPage: response.hasNextPage ? args.page + 1 : null,
    };
  }

  async findAlbums(args: { name?: string; limit: number }) {
    const albums = await this.listAlbums();
    const wanted = args.name?.trim() ? fold(args.name) : undefined;
    const matching = albums
      .filter((album) => !wanted || fold(album.albumName).includes(wanted))
      .sort((a, b) => (b.endDate ?? "").localeCompare(a.endDate ?? ""))
      .slice(0, args.limit)
      .map((album) => ({
        id: album.id,
        name: album.albumName,
        photoCount: album.assetCount,
        ...(album.startDate ? { from: album.startDate.slice(0, 10) } : {}),
        ...(album.endDate ? { to: album.endDate.slice(0, 10) } : {}),
        ...(album.description ? { description: album.description } : {}),
        shared: album.shared,
        url: `${this.options.publicUrl}/albums/${album.id}`,
      }));
    return { albums: matching, count: matching.length };
  }

  // ----- shaping ------------------------------------------------------------

  summarize(asset: Asset): PhotoSummary {
    const exif = asset.exifInfo ?? {};
    const location = [exif.city, exif.state, exif.country].filter(Boolean).join(", ");
    const people = (asset.people ?? [])
      .filter((person) => person.name && !person.isHidden)
      .map((person) => person.name);
    const description = exif.description?.trim();
    return {
      id: asset.id,
      type: asset.type === "IMAGE" ? "photo" : asset.type === "VIDEO" ? "video" : "other",
      takenAt: wallClock(asset.localDateTime),
      fileName: asset.originalFileName,
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...(people.length > 0 ? { people } : {}),
      isFavorite: asset.isFavorite,
      ...(asset.type === "VIDEO" && asset.duration
        ? { durationSeconds: Math.round(asset.duration / 1000) }
        : {}),
      url: `${this.options.publicUrl}/photos/${asset.id}`,
    };
  }
}

function pick(person: PersonRef): { id: string; name: string } {
  return { id: person.id, name: person.name };
}

function personEntry(person: PersonRef) {
  return {
    id: person.id,
    name: person.name,
    ...(person.birthDate ? { birthDate: person.birthDate } : {}),
    ...(person.isFavorite ? { isFavorite: true } : {}),
  };
}

/** OCR lines in reading order: top to bottom, then left to right. */
function readingOrder(lines: OcrLine[]): OcrLine[] {
  return [...lines].sort((a, b) => {
    const rowA = Math.min(a.y1, a.y2);
    const rowB = Math.min(b.y1, b.y2);
    // Boxes whose tops are within ~1% of the frame read as the same row.
    if (Math.abs(rowA - rowB) > 0.01) return rowA - rowB;
    return Math.min(a.x1, a.x4) - Math.min(b.x1, b.x4);
  });
}

export function ocrText(lines: OcrLine[]): string {
  return readingOrder(lines)
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join("\n");
}

/** The OCR lines that contain a word of the query, so the model sees why each photo matched. */
export function matchingLines(lines: OcrLine[], query: string, max = 5): string[] {
  const words = fold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2);
  const ordered = readingOrder(lines).map((line) => line.text.trim());
  const hits = ordered.filter((line) => {
    const folded = fold(line);
    return words.some((word) => folded.includes(word));
  });
  return (hits.length > 0 ? hits : ordered).slice(0, max);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
