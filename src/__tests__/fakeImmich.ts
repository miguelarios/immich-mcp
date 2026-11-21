/**
 * An in-process stand-in for the Immich REST API, behind a `fetch` function.
 *
 * Tests run the real ImmichClient and PhotoLibrary against it, so request
 * shapes (paths, query strings, filter bodies, headers) are asserted exactly
 * as they would reach a server. Every name and place here is a placeholder.
 */
import type { Album, Asset, OcrLine, PersonRef } from "../immich/types.js";

export const IDS = {
  beach: "11111111-1111-4111-8111-111111111111",
  receipt: "22222222-2222-4222-8222-222222222222",
  video: "33333333-3333-4333-8333-333333333333",
  ada: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  jose: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  joseph: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  trip: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  missing: "00000000-0000-4000-8000-000000000000",
};

export const PEOPLE: PersonRef[] = [
  { id: IDS.ada, name: "Ada Lovelace", isHidden: false, birthDate: "1815-12-10" },
  { id: IDS.jose, name: "José Núñez", isHidden: false },
  { id: IDS.joseph, name: "Joseph Núñez", isHidden: false },
  { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "", isHidden: false },
];

export function asset(overrides: Partial<Asset> & { id: string }): Asset {
  return {
    type: "IMAGE",
    originalFileName: "IMG_0001.jpg",
    originalMimeType: "image/jpeg",
    localDateTime: "2024-06-15T07:12:00.000Z",
    fileCreatedAt: "2024-06-15T12:12:00.000Z",
    width: 4032,
    height: 3024,
    duration: null,
    isFavorite: false,
    visibility: "timeline",
    exifInfo: { city: "Playa Example", state: "Quintana Roo", country: "Mexico" },
    people: [],
    tags: [],
    ...overrides,
  };
}

export const ASSETS: Record<string, Asset> = {
  [IDS.beach]: asset({
    id: IDS.beach,
    originalFileName: "IMG_0001.jpg",
    people: [
      { id: IDS.ada, name: "Ada Lovelace" },
      { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", name: "" },
    ],
    exifInfo: {
      city: "Playa Example",
      state: "Quintana Roo",
      country: "Mexico",
      make: "Apple",
      model: "iPhone 15",
      latitude: 20.5,
      longitude: -87.1,
      description: "  Sunrise walk ",
      timeZone: "UTC-5",
      fileSizeInByte: 1234,
    },
    tags: [{ id: "t1", name: "trip", value: "Travel/2024" }],
  }),
  [IDS.receipt]: asset({
    id: IDS.receipt,
    originalFileName: "IMG_0002.png",
    localDateTime: "2024-07-01T13:00:00.000Z",
    exifInfo: {},
  }),
  [IDS.video]: asset({
    id: IDS.video,
    type: "VIDEO",
    originalFileName: "IMG_0003.MOV",
    duration: 63_290,
  }),
};

export const OCR: Record<string, OcrLine[]> = {
  [IDS.receipt]: [
    line(IDS.receipt, "TOTAL $12.50", 0.1, 0.8),
    line(IDS.receipt, "Corner Bakery", 0.1, 0.1),
    line(IDS.receipt, "Receipt #4411", 0.6, 0.1),
    line(IDS.receipt, "Thank you", 0.1, 0.9),
  ],
};

function line(assetId: string, text: string, x: number, y: number): OcrLine {
  return {
    id: `${assetId}-${text}`,
    assetId,
    text,
    textScore: 0.99,
    boxScore: 0.99,
    x1: x,
    y1: y,
    x2: x + 0.3,
    y2: y,
    x3: x + 0.3,
    y3: y + 0.05,
    x4: x,
    y4: y + 0.05,
  };
}

export const ALBUMS: Album[] = [
  {
    id: IDS.trip,
    albumName: "Beach Trip 2024",
    assetCount: 12,
    startDate: "2024-06-14T00:00:00.000Z",
    endDate: "2024-06-20T00:00:00.000Z",
    shared: false,
  },
  {
    id: "99999999-9999-4999-8999-999999999999",
    albumName: "Beach Day",
    assetCount: 3,
    startDate: null,
    endDate: null,
    shared: true,
  },
];

export const PLACES: Record<string, string[]> = {
  city: ["Playa Example", "Ciudad de México", "Zürich"],
  state: ["Quintana Roo", "Texas"],
  country: ["Mexico", "Switzerland", "United States"],
};

export interface Recorded {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: Headers;
  body?: any;
}

export interface FakeImmich {
  fetch: typeof globalThis.fetch;
  calls: Recorded[];
  /** Calls to one endpoint, matched on method and path without the query string. */
  callsTo(method: string, path: string): Recorded[];
  /** Overrides the response for one endpoint. */
  respond(method: string, path: string, response: () => Response | Promise<Response>): void;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function page(items: Asset[], extra: Record<string, unknown> = {}) {
  return {
    albums: { total: 0, count: 0, items: [], facets: [] },
    assets: {
      total: items.length,
      count: items.length,
      items,
      facets: [],
      nextPage: null,
      nextCursor: null,
      ...extra,
    },
  };
}

export function fakeImmich(): FakeImmich {
  const calls: Recorded[] = [];
  const overrides = new Map<string, () => Response | Promise<Response>>();

  const route = (method: string, path: string, search: URLSearchParams, body: any): Response => {
    if (method === "POST" && path === "/api/search/smart") {
      return json(page([ASSETS[IDS.beach], ASSETS[IDS.video]]));
    }
    if (method === "POST" && path === "/api/search/metadata") {
      if (body?.filter?.ocr) return json(page([ASSETS[IDS.receipt]], { nextCursor: "c2" }));
      return json(page(Object.values(ASSETS), { nextCursor: body?.cursor ? null : "c1" }));
    }
    if (method === "GET" && path === "/api/search/person") {
      const wanted = (search.get("name") ?? "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
      return json(
        PEOPLE.filter((p) =>
          p.name
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase()
            .includes(wanted),
        ),
      );
    }
    if (method === "GET" && path === "/api/people") {
      return json({ total: PEOPLE.length, hidden: 0, hasNextPage: true, people: PEOPLE });
    }
    if (method === "GET" && path === "/api/search/suggestions") {
      return json(PLACES[search.get("type") ?? ""] ?? []);
    }
    if (method === "GET" && path === "/api/albums") {
      if (search.get("assetId") === IDS.beach) return json([ALBUMS[0]]);
      if (search.get("assetId")) return json([]);
      return json(ALBUMS);
    }
    const ocr = /^\/api\/assets\/([^/]+)\/ocr$/.exec(path);
    if (method === "GET" && ocr) return json(OCR[ocr[1]] ?? []);
    const thumb = /^\/api\/assets\/([^/]+)\/thumbnail$/.exec(path);
    if (method === "GET" && thumb) {
      const size = search.get("size");
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
        status: 200,
        headers: { "content-type": size === "thumbnail" ? "image/webp" : "image/jpeg" },
      });
    }
    const one = /^\/api\/assets\/([^/]+)$/.exec(path);
    if (method === "GET" && one) {
      const found = ASSETS[one[1]];
      return found ? json(found) : json({ message: "Not found or no asset.read access" }, 400);
    }
    return json({ message: `fake: no route for ${method} ${path}` }, 500);
  };

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      path: url.pathname,
      search: url.searchParams,
      headers: new Headers(init?.headers),
      body,
    });
    const override = overrides.get(`${method} ${url.pathname}`);
    if (override) return override();
    return route(method, url.pathname, url.searchParams, body);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    callsTo: (method, path) => calls.filter((c) => c.method === method && c.path === path),
    respond: (method, path, response) => overrides.set(`${method} ${path}`, response),
  };
}

export const BASE = "https://photos.example.test";
