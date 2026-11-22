import { describe, expect, it } from "vitest";
import { InputError, NotFoundError } from "../errors.js";
import { ImmichClient } from "../immich/client.js";
import { PhotoLibrary, matchingLines, ocrText } from "../library/PhotoLibrary.js";
import { containsPattern, fold } from "../library/text.js";
import {
  ALBUMS,
  ASSETS,
  BASE,
  IDS,
  OCR,
  READ_PERMISSIONS,
  TAGS,
  fakeImmich,
} from "./fakeImmich.js";

function setup(timeZone = "America/Chicago") {
  const fake = fakeImmich();
  const client = new ImmichClient({ baseUrl: BASE, apiKey: "k", timeoutMs: 30_000 }, fake.fetch);
  const library = new PhotoLibrary(client, { publicUrl: "https://share.example.test", timeZone });
  return { fake, library };
}

describe("text helpers", () => {
  it("folds case, accents and whitespace", () => {
    expect(fold("  José   Núñez ")).toBe("jose nunez");
    expect(fold("ZÜRICH")).toBe("zurich");
  });

  it("escapes LIKE wildcards so file names match literally", () => {
    expect(containsPattern("IMG_0033")).toBe("%IMG\\_0033%");
    expect(containsPattern("100%")).toBe("%100\\%%");
    expect(containsPattern("a\\b")).toBe("%a\\\\b%");
  });
});

describe("resolvePerson", () => {
  it("matches a full name regardless of case and accents", async () => {
    const { library } = setup();
    await expect(library.resolvePerson("jose nunez")).resolves.toEqual({
      id: IDS.jose,
      name: "José Núñez",
    });
  });

  it("accepts a first name when it is unique", async () => {
    const { library } = setup();
    await expect(library.resolvePerson("ada")).resolves.toEqual({
      id: IDS.ada,
      name: "Ada Lovelace",
    });
  });

  it("refuses an ambiguous name and lists the candidates", async () => {
    const { library } = setup();
    const error = await library.resolvePerson("Núñez").catch((e) => e);
    expect(error).toBeInstanceOf(InputError);
    expect(error.message).toContain("José Núñez, Joseph Núñez");
  });

  it("points at list_people when nobody matches, ignoring unnamed faces", async () => {
    const { library, fake } = setup();
    fake.respond("GET", "/api/search/person", () =>
      Response.json([{ id: "x", name: "", isHidden: false }]),
    );
    const error = await library.resolvePerson("Nobody").catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toContain("list_people");
  });

  it("refuses two people with the same name rather than picking one", async () => {
    const { library, fake } = setup();
    fake.respond("GET", "/api/search/person", () =>
      Response.json([
        { id: IDS.ada, name: "Ada Lovelace", isHidden: false },
        { id: IDS.jose, name: "Ada Lovelace", isHidden: false },
      ]),
    );
    await expect(library.resolvePerson("ada lovelace")).rejects.toThrow("matches several people");
  });

  it("does not accept a sole candidate that only contains the query mid-word", async () => {
    const { library, fake } = setup();
    fake.respond("GET", "/api/search/person", () =>
      Response.json([{ id: IDS.ada, name: "Olivia Example", isHidden: false }]),
    );
    const error = await library.resolvePerson("li").catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toContain("closest: Olivia Example");
    await expect(library.resolvePerson("example")).resolves.toMatchObject({ id: IDS.ada });
  });

  it("passes a person id through without a lookup", async () => {
    const { library, fake } = setup();
    await expect(library.resolvePerson(IDS.ada)).resolves.toMatchObject({ id: IDS.ada });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("resolveAlbum and resolvePlace", () => {
  it("prefers an exact album name over a partial match", async () => {
    const { library } = setup();
    await expect(library.resolveAlbum("beach day")).resolves.toMatchObject({ name: "Beach Day" });
    await expect(library.resolveAlbum("trip")).resolves.toEqual({
      id: IDS.trip,
      name: "Beach Trip 2024",
    });
    await expect(library.resolveAlbum("beach")).rejects.toThrow("several albums");
    await expect(library.resolveAlbum("Ski")).rejects.toThrow("list_albums");
  });

  it("refuses two albums with the same name", async () => {
    const { library, fake } = setup();
    fake.respond("GET", "/api/albums", () =>
      Response.json([ALBUMS[0], { ...ALBUMS[0], id: IDS.jose }]),
    );
    await expect(library.resolveAlbum("beach trip 2024")).rejects.toThrow("Pass the album id");
  });

  it("caches the album list", async () => {
    const { library, fake } = setup();
    await library.resolveAlbum("trip");
    await library.resolveAlbum("beach day");
    expect(fake.callsTo("GET", "/api/albums")).toHaveLength(1);
  });

  it("resolves places to every spelling Immich stored for them", async () => {
    const { library } = setup();
    await expect(library.resolvePlace("city", "ciudad de méxico")).resolves.toEqual([
      "Ciudad de México",
      "Ciudad de Mexico",
    ]);
    await expect(library.resolvePlace("city", "ZURICH")).resolves.toEqual(["Zürich"]);
  });

  it("suggests close places when there is no exact one", async () => {
    const { library } = setup();
    const error = await library.resolvePlace("city", "ciudad").catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toContain("Close matches: Ciudad de México");
    await expect(library.resolvePlace("country", "Atlantis")).rejects.toThrow(
      'No photos have country "Atlantis".',
    );
  });
});

describe("buildFilter", () => {
  it("defaults to timeline photos and videos only", async () => {
    const { library } = setup();
    const { filter, applied } = await library.buildFilter({});
    expect(filter).toEqual({
      type: { in: ["IMAGE", "VIDEO"] },
      visibility: { in: ["timeline"] },
    });
    expect(applied).toEqual({});
  });

  it("translates every filter and reports what it resolved to", async () => {
    const { library } = setup();
    const { filter, applied } = await library.buildFilter({
      people: ["ada", "José Núñez", IDS.ada],
      album: "trip",
      place: { city: "playa example", state: "quintana roo", country: "mexico" },
      taken: { from: "2024-06", to: "2024-06" },
      camera: { make: "apple", model: "IPHONE 15", lens: "xf23mmf2 r wr" },
      tags: ["travel/2024", "recetas", TAGS[3].id],
      minRating: 4,
      mediaType: "video",
      favoritesOnly: true,
      includeArchived: true,
    });
    expect(filter).toEqual({
      personIds: { all: [IDS.ada, IDS.jose] },
      albumIds: { any: [IDS.trip] },
      city: { in: ["Playa Example"] },
      state: { in: ["Quintana Roo"] },
      country: { in: ["Mexico"] },
      takenAt: { gte: "2024-06-01T05:00:00.000Z", lt: "2024-07-01T05:00:00.000Z" },
      make: { in: ["Apple"] },
      model: { in: ["iPhone 15"] },
      lensModel: { in: ["XF23mmF2 R WR"] },
      tagIds: { all: [TAGS[1].id, TAGS[3].id] },
      rating: { gte: 4 },
      type: { eq: "VIDEO" },
      isFavorite: { eq: true },
      visibility: { in: ["timeline", "archive"] },
    });
    expect(applied.people).toEqual([
      { id: IDS.ada, name: "Ada Lovelace" },
      { id: IDS.jose, name: "José Núñez" },
    ]);
    expect(applied).toMatchObject({
      album: { id: IDS.trip, name: "Beach Trip 2024" },
      city: "Playa Example",
      cameraMake: "Apple",
      cameraModel: "iPhone 15",
      lens: "XF23mmF2 R WR",
      tags: [
        { id: TAGS[1].id, name: "Travel/2024" },
        { id: TAGS[3].id, name: "Recetas" },
      ],
      minRating: 4,
      mediaType: "video",
      favoritesOnly: true,
      includeArchived: true,
    });
  });

  it("fails the whole search when one name does not resolve", async () => {
    const { library } = setup();
    await expect(
      library.buildFilter({ people: ["ada"], place: { city: "Atlantis" } }),
    ).rejects.toThrow(NotFoundError);
  });

  it("filters for photos with no tag and no rating", async () => {
    const { library } = setup();
    const { filter, applied } = await library.buildFilter({ untagged: true, unrated: true });
    expect(filter).toMatchObject({ hasTags: { eq: false }, rating: { eq: null } });
    expect(applied).toEqual({ untagged: true, unrated: true });
  });

  it("refuses filters that contradict each other", async () => {
    const { library } = setup();
    await expect(library.buildFilter({ untagged: true, tags: ["travel"] })).rejects.toThrow(
      "untagged cannot be combined with tags",
    );
    await expect(library.buildFilter({ unrated: true, minRating: 3 })).rejects.toThrow(
      "unrated cannot be combined with minRating",
    );
  });

  it("offers the close camera models rather than guessing between them", async () => {
    const { library } = setup();
    await expect(library.buildFilter({ camera: { model: "iphone" } })).rejects.toThrow(
      'No photos have camera model "iphone". Close matches: iPhone 15, iPhone 15 Pro.',
    );
  });
});

describe("resolveTag", () => {
  it("matches a full path, or a last part when only one tag ends in it", async () => {
    const { library } = setup();
    await expect(library.resolveTag("family/2024")).resolves.toEqual({
      id: TAGS[2].id,
      name: "Family/2024",
    });
    await expect(library.resolveTag("TRAVEL")).resolves.toEqual({ id: TAGS[0].id, name: "Travel" });
    await expect(library.resolveTag("recet")).resolves.toEqual({ id: TAGS[3].id, name: "Recetas" });
  });

  it("asks for the full path when a name is shared, and names what it could have meant", async () => {
    const { library } = setup();
    await expect(library.resolveTag("2024")).rejects.toThrow(
      '"2024" matches several tags: Travel/2024, Family/2024. Pass the full path.',
    );
    await expect(library.resolveTag("nothing")).rejects.toThrow(NotFoundError);
  });

  it("says how to fix a key that cannot read tags, and leaves other filters working", async () => {
    const { fake, library } = setup();
    fake.apiKeys.set("k", READ_PERMISSIONS);
    await expect(library.buildFilter({ tags: ["travel"] })).rejects.toThrow("lacks tag.read");
    await expect(library.buildFilter({ minRating: 5 })).resolves.toMatchObject({
      filter: { rating: { gte: 5 } },
    });
  });
});

describe("list_tags and list_cameras", () => {
  it("lists tags as full paths, filtered by name", async () => {
    const { library } = setup();
    const all = await library.findTags({ limit: 200 });
    expect(all.tags.map((tag) => tag.name)).toEqual([
      "Family/2024",
      "Recetas",
      "Travel",
      "Travel/2024",
    ]);
    expect((await library.findTags({ name: "travel", limit: 200 })).count).toBe(2);
  });

  it("lists the cameras the library has, and one make's models", async () => {
    const { fake, library } = setup();
    expect(await library.listCameras({})).toEqual({
      makes: ["Apple", "FUJIFILM"],
      models: ["iPhone 15", "iPhone 15 Pro", "X-T5"],
      lenses: ["iPhone 15 back camera 6.86mm f/1.78", "XF23mmF2 R WR"],
    });
    const fuji = await library.listCameras({ make: "fujifilm" });
    expect(fuji.makes).toEqual(["FUJIFILM"]);
    expect(fuji.models).toEqual(["X-T5"]);
    const scoped = fake
      .callsTo("GET", "/api/search/suggestions")
      .find((call) => call.search.get("make"));
    expect(scoped?.search.get("make")).toBe("FUJIFILM");
  });
});

describe("searches", () => {
  it("search by context sends the query with filters and exif", async () => {
    const { library, fake } = setup();
    const result = await library.searchByContext({ query: " sunrise ", limit: 7, people: ["ada"] });
    const [call] = fake.callsTo("POST", "/api/search/smart");
    expect(call.body).toEqual({
      query: "sunrise",
      size: 7,
      withExif: true,
      filter: expect.objectContaining({ personIds: { all: [IDS.ada] } }),
    });
    expect(call.body).not.toHaveProperty("page");
    expect(result.count).toBe(2);
    expect(result.photos.map((p) => p.id)).toEqual([IDS.beach, IDS.video]);
  });

  it("search by text filters on OCR and attaches the matching lines", async () => {
    const { library, fake } = setup();
    const result = await library.searchByText({
      text: "receipt total",
      limit: 10,
      includeText: true,
    });
    const [call] = fake.callsTo("POST", "/api/search/metadata");
    expect(call.body.filter.ocr).toEqual({ matches: "receipt total" });
    expect(call.body).toMatchObject({ size: 10, withExif: true, withPeople: true });
    expect(result.nextCursor).toBe("c2");
    expect(result.photos[0].matchedText).toEqual(["Receipt #4411", "TOTAL $12.50"]);
  });

  it("search by text can skip the OCR fetches", async () => {
    const { library, fake } = setup();
    const result = await library.searchByText({ text: "receipt", limit: 10, includeText: false });
    expect(fake.calls.some((c) => c.path.endsWith("/ocr"))).toBe(false);
    expect(result.photos[0]).not.toHaveProperty("matchedText");
  });

  it("search by text treats a photo with no OCR record as no lines", async () => {
    const { library, fake } = setup();
    fake.respond("GET", `/api/assets/${IDS.receipt}/ocr`, () =>
      Response.json({ message: "Not found or no asset.read access" }, { status: 400 }),
    );
    const result = await library.searchByText({ text: "receipt", limit: 10, includeText: true });
    expect(result.photos[0].matchedText).toEqual([]);
  });

  it("search by metadata escapes patterns, sorts by capture time and pages by cursor", async () => {
    const { library, fake } = setup();
    const first = await library.searchByMetadata({
      fileName: "IMG_0003",
      path: "2019/Japan_trip",
      description: "walk",
      limit: 5,
      sort: "oldest",
    });
    const [call] = fake.callsTo("POST", "/api/search/metadata");
    expect(call.body.filter.originalPath).toEqual({ like: "%2019/Japan\\_trip%" });
    expect(call.body.filter.originalFileName).toEqual({ like: "%IMG\\_0003%" });
    expect(call.body.filter.description).toEqual({ like: "%walk%" });
    expect(call.body.orderBy).toEqual({ field: "fileCreatedAt", direction: "asc" });
    expect(first.nextCursor).toBe("c1");

    const second = await library.searchByMetadata({ limit: 5, cursor: "c1" });
    expect(fake.callsTo("POST", "/api/search/metadata")[1].body.cursor).toBe("c1");
    expect(fake.callsTo("POST", "/api/search/metadata")[1].body.orderBy.direction).toBe("desc");
    expect(second.nextCursor).toBeNull();
  });

  it("rejects empty queries before calling Immich", async () => {
    const { library, fake } = setup();
    await expect(library.searchByContext({ query: "  ", limit: 5 })).rejects.toThrow(InputError);
    await expect(library.searchByText({ text: "", limit: 5, includeText: true })).rejects.toThrow(
      InputError,
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("summaries and details", () => {
  it("summarizes an asset compactly, with named people only and a public link", async () => {
    const { library } = setup();
    const { photos } = await library.searchByMetadata({ limit: 5 });
    expect(photos[0]).toEqual({
      id: IDS.beach,
      type: "photo",
      takenAt: "2024-06-15T07:12:00",
      fileName: "IMG_0001.jpg",
      location: "Playa Example, Quintana Roo, Mexico",
      description: "Sunrise walk",
      people: ["Ada Lovelace"],
      isFavorite: false,
      url: `https://share.example.test/photos/${IDS.beach}`,
    });
    expect(photos[1]).not.toHaveProperty("location");
    expect(photos[2]).toMatchObject({ type: "video", durationSeconds: 63 });
  });

  it("get_photo gathers exif, albums, tags and the OCR text in reading order", async () => {
    const { library } = setup();
    const beach = await library.getPhoto(IDS.beach, true);
    expect(beach.path).toBe("/data/library/ada/2024/Beach Trip/IMG_0001.jpg");
    expect(beach).toMatchObject({
      takenAtUtc: "2024-06-15T12:12:00.000Z",
      timeZone: "UTC-5",
      coordinates: { latitude: 20.5, longitude: -87.1 },
      camera: "Apple iPhone 15",
      dimensions: "4032x3024",
      fileSizeBytes: 1234,
      albums: ["Beach Trip 2024"],
      tags: ["Travel/2024"],
      isArchived: false,
      text: "",
    });
    const receipt = await library.getPhoto(IDS.receipt, true);
    expect(receipt.text).toBe("Corner Bakery\nReceipt #4411\nTOTAL $12.50\nThank you");
    expect(receipt).not.toHaveProperty("camera");
    expect(await library.getPhoto(IDS.receipt, false)).not.toHaveProperty("text");
  });

  it("rejects something that is not a photo id", async () => {
    const { library } = setup();
    await expect(library.getPhoto("IMG_0001.jpg", true)).rejects.toThrow("not a photo id");
    await expect(library.viewPhoto("../etc", "preview")).rejects.toThrow("not a photo id");
  });

  it("matchingLines returns only lines containing a query word, never filler", () => {
    const lines = OCR[IDS.receipt];
    expect(matchingLines(lines, "bakery")).toEqual(["Corner Bakery"]);
    expect(matchingLines(lines, "zzz")).toEqual([]);
    expect(ocrText([])).toBe("");
  });

  it("get_photo drops tags with no name instead of failing its schema", async () => {
    const { library, fake } = setup();
    fake.respond("GET", `/api/assets/${IDS.receipt}`, () =>
      Response.json({
        ...ASSETS[IDS.receipt],
        tags: [
          { id: "t", name: "" },
          { id: "u", name: "Kept" },
        ],
      }),
    );
    expect((await library.getPhoto(IDS.receipt, false)).tags).toEqual(["Kept"]);
  });

  it("surfaces a permission error from a side lookup instead of reporting no text", async () => {
    const { library, fake } = setup();
    fake.respond("GET", `/api/assets/${IDS.receipt}/ocr`, () =>
      Response.json({ message: "Missing required permission: asset.read" }, { status: 403 }),
    );
    await expect(library.getPhoto(IDS.receipt, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      library.searchByText({ text: "receipt", limit: 5, includeText: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("browsing", () => {
  it("lists only named, visible people", async () => {
    const { library, fake } = setup();
    const all = await library.listPeople({ limit: 50, page: 1 });
    expect(all.people.map((p) => p.name)).toEqual(["Ada Lovelace", "José Núñez", "Joseph Núñez"]);
    expect(all.people[0]).toEqual({ id: IDS.ada, name: "Ada Lovelace", birthDate: "1815-12-10" });
    expect(all.nextPage).toBe(2);
    expect(fake.callsTo("GET", "/api/people")[0].search.get("size")).toBe("50");

    const named = await library.listPeople({ name: "nunez", limit: 1, page: 1 });
    expect(named.people.map((p) => p.name)).toEqual(["José Núñez"]);
    expect(named.nextPage).toBeNull();
  });

  it("lists albums newest first with links, filtered by name", async () => {
    const { library } = setup();
    const { albums } = await library.findAlbums({ limit: 10 });
    expect(albums.map((a) => a.name)).toEqual(["Beach Trip 2024", "Beach Day"]);
    expect(albums[0]).toEqual({
      id: IDS.trip,
      name: "Beach Trip 2024",
      photoCount: 12,
      from: "2024-06-14",
      to: "2024-06-20",
      shared: false,
      url: `https://share.example.test/albums/${IDS.trip}`,
    });
    expect((await library.findAlbums({ name: "day", limit: 10 })).count).toBe(1);
  });
});
