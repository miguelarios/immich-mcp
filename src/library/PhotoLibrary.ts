import { ImmichMcpError, InputError, NotFoundError } from "../errors.js";
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
  Tag,
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
  /** Where it was taken. */
  place?: { city?: string; state?: string; country?: string };
  /** When it was taken: calendar periods or timestamps, both ends inclusive. */
  taken?: { from?: string; to?: string };
  /** What it was taken with. */
  camera?: { make?: string; model?: string; lens?: string };
  /** Tag names, paths or ids that must all be on the photo. */
  tags?: string[];
  /** Only photos with no tag at all. */
  untagged?: boolean;
  /** At least this many stars (1-5). */
  minRating?: number;
  /** Only photos with no star rating. */
  unrated?: boolean;
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
  cameraMake?: string;
  cameraModel?: string;
  lens?: string;
  tags?: { id: string; name: string }[];
  untagged?: boolean;
  minRating?: number;
  unrated?: boolean;
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
  private tags?: Cached<Tag[]>;
  private readonly known = new Map<SuggestionType, Cached<string[]>>();

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
    const ambiguous = (candidates: PersonRef[]) =>
      new InputError(
        `"${value}" matches several people: ${candidates
          .slice(0, 10)
          .map((person) => person.name)
          .join(", ")}. Pass the full name or the person id.`,
      );
    const exact = matches.filter((person) => fold(person.name) === wanted);
    if (exact.length === 1) return pick(exact[0]);
    if (exact.length > 1) throw ambiguous(exact);
    // "Jose" for "José Núñez": a unique match on the first name is what the user meant.
    const byFirst = matches.filter((person) => fold(person.name).split(" ")[0] === wanted);
    if (byFirst.length === 1) return pick(byFirst[0]);
    // A sole candidate is accepted only when the query starts one of its words, so
    // "nunez" finds "José Núñez" but "li" does not silently become "Olivia".
    const byWord = matches.filter((person) =>
      fold(person.name)
        .split(" ")
        .some((word) => word.startsWith(wanted)),
    );
    if (byWord.length === 1) return pick(byWord[0]);
    if (matches.length > 1 || byWord.length > 1)
      throw ambiguous(byWord.length > 1 ? byWord : matches);
    throw new NotFoundError(
      `No named person matches "${value}" (closest: ${matches[0].name}). Pass the full name or call list_people.`,
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
    if (exact.length === 1) return { id: exact[0].id, name: exact[0].albumName };
    if (exact.length > 1) {
      throw new InputError(
        `${exact.length} albums are named "${exact[0].albumName}". Pass the album id from list_albums.`,
      );
    }
    const partial = albums.filter((album) => fold(album.albumName).includes(wanted));
    if (partial.length === 1) return { id: partial[0].id, name: partial[0].albumName };
    if (partial.length > 1) {
      const names = partial.slice(0, 10).map((album) => album.albumName);
      throw new InputError(`"${value}" matches several albums: ${names.join(", ")}.`);
    }
    throw new NotFoundError(`No album is named "${value}". Call list_albums to see them.`);
  }

  /**
   * Immich filters places and camera fields by exact, case-sensitive value, so
   * "cancun" finds nothing when it stored "Cancún". Resolve against the values
   * the library actually has.
   */
  async resolveKnown(kind: SuggestionType, label: string, ref: string): Promise<string[]> {
    const value = ref.trim();
    if (!value) throw new InputError(`${label} cannot be empty.`);
    const known = await this.knownValues(kind);
    const wanted = fold(value);
    // Every stored spelling that folds equal is searched: geocoding and EXIF can
    // store both "Cancún" and "Cancun" for the same place.
    const exact = known.filter((entry) => fold(entry) === wanted);
    if (exact.length > 0) return exact;
    const close = known.filter((entry) => fold(entry).includes(wanted)).slice(0, 10);
    const hint = close.length > 0 ? ` Close matches: ${close.join(", ")}.` : "";
    throw new NotFoundError(`No photos have ${label} "${value}".${hint}`);
  }

  resolvePlace(kind: "city" | "state" | "country", ref: string): Promise<string[]> {
    return this.resolveKnown(kind, kind, ref);
  }

  /** A tag by id, full path ("Travel/2024") or, when only one tag ends in it, its last part. */
  async resolveTag(ref: string): Promise<{ id: string; name: string }> {
    const value = ref.trim();
    if (!value) throw new InputError("A tag cannot be empty.");
    const tags = await this.listTags();
    if (isUuid(value)) {
      const tag = tags.find((entry) => entry.id === value);
      return { id: value, name: tag?.value ?? value };
    }
    const wanted = fold(value);
    const several = (candidates: Tag[]) =>
      new InputError(
        `"${value}" matches several tags: ${candidates
          .slice(0, 10)
          .map((tag) => tag.value)
          .join(", ")}. Pass the full path.`,
      );
    for (const candidates of [
      tags.filter((tag) => fold(tag.value) === wanted),
      tags.filter((tag) => fold(tag.name) === wanted),
      tags.filter((tag) => fold(tag.value).includes(wanted)),
    ]) {
      if (candidates.length === 1) return { id: candidates[0].id, name: candidates[0].value };
      if (candidates.length > 1) throw several(candidates);
    }
    throw new NotFoundError(`No tag matches "${value}". Call list_tags to see them.`);
  }

  async listAlbums(): Promise<Album[]> {
    const now = Date.now();
    if (!this.albums || this.albums.expires <= now) {
      this.albums = { value: await this.client.listAlbums(), expires: now + this.cacheTtlMs };
    }
    return this.albums.value;
  }

  async listTags(): Promise<Tag[]> {
    const now = Date.now();
    if (!this.tags || this.tags.expires <= now) {
      let value: Tag[];
      try {
        value = await this.client.listTags();
      } catch (err) {
        if (err instanceof ImmichMcpError && err.code === "FORBIDDEN") {
          throw new ImmichMcpError(
            "FORBIDDEN",
            "This connection's Immich API key cannot read tags (it lacks tag.read). " +
              "Tell the user to reconnect the connector and sign in again, which creates a key that can; " +
              "every other filter works meanwhile.",
          );
        }
        throw err;
      }
      this.tags = { value, expires: now + this.cacheTtlMs };
    }
    return this.tags.value;
  }

  private async knownValues(kind: SuggestionType): Promise<string[]> {
    const now = Date.now();
    const cached = this.known.get(kind);
    if (cached && cached.expires > now) return cached.value;
    const value = (await this.client.suggestions(kind)).filter(Boolean);
    this.known.set(kind, { value, expires: now + this.cacheTtlMs });
    return value;
  }

  /** Builds Immich's `filter` object and reports what each name resolved to. */
  async buildFilter(
    filters: CommonFilters,
  ): Promise<{ filter: SearchFilter; applied: AppliedFilters }> {
    const filter: SearchFilter = {};
    const applied: AppliedFilters = {};

    if (filters.untagged && filters.tags?.length) {
      throw new InputError(
        "untagged cannot be combined with tags: a photo has tags or it has none.",
      );
    }
    if (filters.unrated && filters.minRating !== undefined) {
      throw new InputError("unrated cannot be combined with minRating.");
    }

    const { place = {}, camera = {} } = filters;
    const [people, album, city, state, country, make, model, lens, tags] = await Promise.all([
      filters.people?.length
        ? Promise.all(filters.people.map((ref) => this.resolvePerson(ref)))
        : undefined,
      filters.album ? this.resolveAlbum(filters.album) : undefined,
      place.city ? this.resolvePlace("city", place.city) : undefined,
      place.state ? this.resolvePlace("state", place.state) : undefined,
      place.country ? this.resolvePlace("country", place.country) : undefined,
      camera.make ? this.resolveKnown("camera-make", "camera make", camera.make) : undefined,
      camera.model ? this.resolveKnown("camera-model", "camera model", camera.model) : undefined,
      camera.lens ? this.resolveKnown("camera-lens-model", "lens", camera.lens) : undefined,
      filters.tags?.length
        ? Promise.all(filters.tags.map((ref) => this.resolveTag(ref)))
        : undefined,
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
      filter.city = { in: city };
      applied.city = city.join(" / ");
    }
    if (state) {
      filter.state = { in: state };
      applied.state = state.join(" / ");
    }
    if (country) {
      filter.country = { in: country };
      applied.country = country.join(" / ");
    }

    const taken = takenRange(filters.taken?.from, filters.taken?.to, this.options.timeZone);
    if (taken) {
      filter.takenAt = taken;
      applied.takenAt = taken;
    }

    if (make) {
      filter.make = { in: make };
      applied.cameraMake = make.join(" / ");
    }
    if (model) {
      filter.model = { in: model };
      applied.cameraModel = model.join(" / ");
    }
    if (lens) {
      filter.lensModel = { in: lens };
      applied.lens = lens.join(" / ");
    }

    if (tags) {
      const unique = [...new Map(tags.map((tag) => [tag.id, tag])).values()];
      filter.tagIds = { all: unique.map((tag) => tag.id) };
      applied.tags = unique;
    }
    if (filters.untagged) {
      filter.hasTags = { eq: false };
      applied.untagged = true;
    }

    if (filters.minRating !== undefined) {
      filter.rating = { gte: filters.minRating };
      applied.minRating = filters.minRating;
    }
    if (filters.unrated) {
      filter.rating = { eq: null };
      applied.unrated = true;
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
        this.client.getAssetOcr(asset.id).catch(onlyNotFound([] as OcrLine[])),
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
      this.client.getAlbumsForAsset(id).catch(onlyNotFound([] as Album[])),
      includeText ? this.client.getAssetOcr(id).catch(onlyNotFound([] as OcrLine[])) : undefined,
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
      tags: (asset.tags ?? [])
        .map((tag) => tag.value || tag.name)
        .filter((tag): tag is string => Boolean(tag)),
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

  async findTags(args: { name?: string; limit: number }) {
    const wanted = args.name?.trim() ? fold(args.name) : undefined;
    const tags = (await this.listTags())
      .filter((tag) => !wanted || fold(tag.value).includes(wanted))
      .sort((a, b) => a.value.localeCompare(b.value))
      .slice(0, args.limit)
      .map((tag) => ({ id: tag.id, name: tag.value }));
    return { tags, count: tags.length };
  }

  /** The camera values the library has. With `make`, the models are that make's only. */
  async listCameras(args: { make?: string }) {
    const make = args.make?.trim()
      ? await this.resolveKnown("camera-make", "camera make", args.make)
      : undefined;
    const [makes, models, lenses] = await Promise.all([
      make ? Promise.resolve(make) : this.knownValues("camera-make"),
      make
        ? Promise.all(
            make.map((entry) => this.client.suggestions("camera-model", { make: entry })),
          ).then((lists) => [...new Set(lists.flat().filter(Boolean))])
        : this.knownValues("camera-model"),
      this.knownValues("camera-lens-model"),
    ]);
    const sorted = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));
    return { makes: sorted(makes), models: sorted(models), lenses: sorted(lenses) };
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

/**
 * For side lookups (OCR lines, album membership): a photo with none answers
 * not-found, which means "empty". Anything else (a revoked key, a missing
 * permission, a timeout) must surface rather than read as "no text".
 */
function onlyNotFound<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (err instanceof NotFoundError) return fallback;
    throw err;
  };
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

/**
 * The OCR lines that contain a word of the query, so the model sees why each
 * photo matched. Empty when Immich matched fuzzily and no line contains a
 * query word verbatim; unrelated lines would read as false evidence.
 */
export function matchingLines(lines: OcrLine[], query: string, max = 5): string[] {
  const words = fold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2);
  const ordered = readingOrder(lines).map((line) => line.text.trim());
  const hits = ordered.filter((line) => {
    const folded = fold(line);
    return words.some((word) => folded.includes(word));
  });
  return hits.slice(0, max);
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
