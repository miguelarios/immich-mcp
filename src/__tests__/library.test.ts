import { describe, expect, it } from "vitest";
import { InputError, NotFoundError } from "../errors.js";
import { ImmichClient } from "../immich/client.js";
import { PhotoLibrary, matchingLines, ocrText } from "../library/PhotoLibrary.js";
import { containsPattern, fold } from "../library/text.js";
import { BASE, IDS, OCR, fakeImmich } from "./fakeImmich.js";

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

  it("caches the album list", async () => {
    const { library, fake } = setup();
    await library.resolveAlbum("trip");
    await library.resolveAlbum("beach day");
    expect(fake.callsTo("GET", "/api/albums")).toHaveLength(1);
  });

  it("resolves places to the exact spelling Immich stored", async () => {
    const { library } = setup();
    await expect(library.resolvePlace("city", "ciudad de mexico")).resolves.toBe(
      "Ciudad de México",
    );
    await expect(library.resolvePlace("city", "ZURICH")).resolves.toBe("Zürich");
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
      city: "playa example",
      state: "quintana roo",
      country: "mexico",
      takenFrom: "2024-06",
      takenTo: "2024-06",
      mediaType: "video",
      favoritesOnly: true,
      includeArchived: true,
    });
    expect(filter).toEqual({
      personIds: { all: [IDS.ada, IDS.jose] },
      albumIds: { any: [IDS.trip] },
      city: { eq: "Playa Example" },
      state: { eq: "Quintana Roo" },
      country: { eq: "Mexico" },
      takenAt: { gte: "2024-06-01T05:00:00.000Z", lt: "2024-07-01T05:00:00.000Z" },
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
      mediaType: "video",
      favoritesOnly: true,
      includeArchived: true,
    });
  });

  it("fails the whole search when one name does not resolve", async () => {
    const { library } = setup();
    await expect(library.buildFilter({ people: ["ada"], city: "Atlantis" })).rejects.toThrow(
      NotFoundError,
    );
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

  it("search by text survives one photo's OCR failing", async () => {
    const { library, fake } = setup();
    fake.respond("GET", `/api/assets/${IDS.receipt}/ocr`, () => new Response("", { status: 500 }));
    const result = await library.searchByText({ text: "receipt", limit: 10, includeText: true });
    expect(result.photos[0].matchedText).toEqual([]);
  });

  it("search by metadata escapes patterns, sorts by capture time and pages by cursor", async () => {
    const { library, fake } = setup();
    const first = await library.searchByMetadata({
      fileName: "IMG_0003",
      description: "walk",
      limit: 5,
      sort: "oldest",
    });
    const [call] = fake.callsTo("POST", "/api/search/metadata");
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

  it("matchingLines falls back to the first lines when no word matches", () => {
    const lines = OCR[IDS.receipt];
    expect(matchingLines(lines, "bakery")).toEqual(["Corner Bakery"]);
    expect(matchingLines(lines, "zzz", 2)).toEqual(["Corner Bakery", "Receipt #4411"]);
    expect(ocrText([])).toBe("");
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
