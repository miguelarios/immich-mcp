import { describe, expect, it } from "vitest";
import { ImmichMcpError, InputError, NotFoundError } from "../errors.js";
import { ImmichClient, MAX_IMAGE_BYTES } from "../immich/client.js";
import { BASE, IDS, fakeImmich } from "./fakeImmich.js";

const make = (fetch: typeof globalThis.fetch, timeoutMs = 30_000) =>
  new ImmichClient({ baseUrl: BASE, apiKey: "secret-key", timeoutMs }, fetch);

const respondWith = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ImmichClient", () => {
  it("authenticates with x-api-key and calls under /api", async () => {
    const fake = fakeImmich();
    await make(fake.fetch).getAsset(IDS.beach);
    const [call] = fake.calls;
    expect(call.path).toBe(`/api/assets/${IDS.beach}`);
    expect(call.headers.get("x-api-key")).toBe("secret-key");
    expect(call.headers.get("accept")).toBe("application/json");
    expect(call.headers.get("content-type")).toBeNull();
  });

  it("sends search bodies as JSON", async () => {
    const fake = fakeImmich();
    await make(fake.fetch).smartSearch({ query: "dog", size: 5 });
    const [call] = fake.callsTo("POST", "/api/search/smart");
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.body).toEqual({ query: "dog", size: 5 });
  });

  it("encodes query parameters", async () => {
    const fake = fakeImmich();
    await make(fake.fetch).searchPeople("José & Co");
    expect(fake.calls[0].search.get("name")).toBe("José & Co");
    expect(fake.calls[0].search.get("withHidden")).toBe("false");
  });

  it("maps 401 to AUTH_FAILED with Immich's message", async () => {
    const fake = fakeImmich();
    fake.respond(
      "GET",
      `/api/assets/${IDS.beach}`,
      respondWith(401, { message: "Invalid API key" }),
    );
    await expect(make(fake.fetch).getAsset(IDS.beach)).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: expect.stringContaining("Invalid API key"),
    });
  });

  it("maps 403 to FORBIDDEN, naming the missing permission", async () => {
    const fake = fakeImmich();
    fake.respond(
      "GET",
      `/api/assets/${IDS.beach}/ocr`,
      respondWith(403, { message: "Missing required permission: asset.read" }),
    );
    await expect(make(fake.fetch).getAssetOcr(IDS.beach)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("asset.read"),
    });
  });

  it("reads Immich's 400 'not found' as NOT_FOUND, and other 400s as bad input", async () => {
    const fake = fakeImmich();
    await expect(make(fake.fetch).getAsset(IDS.missing)).rejects.toBeInstanceOf(NotFoundError);

    fake.respond(
      "POST",
      "/api/search/metadata",
      respondWith(400, { message: ["size must not be greater than 1000", "bad cursor"] }),
    );
    const error = await make(fake.fetch)
      .metadataSearch({ size: 5000 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(InputError);
    expect(error.message).toContain("size must not be greater than 1000; bad cursor");
  });

  it("marks 5xx and 429 retryable, other statuses not", async () => {
    const fake = fakeImmich();
    fake.respond("GET", "/api/albums", () => new Response("upstream down", { status: 502 }));
    await expect(make(fake.fetch).listAlbums()).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      retryable: true,
      message: expect.stringContaining("upstream down"),
    });
    fake.respond("GET", "/api/albums", () => new Response("", { status: 429 }));
    await expect(make(fake.fetch).listAlbums()).rejects.toMatchObject({ retryable: true });
    fake.respond("GET", "/api/albums", () => new Response("", { status: 409 }));
    await expect(make(fake.fetch).listAlbums()).rejects.toMatchObject({ retryable: false });
  });

  it("reports an unreachable server as a retryable connection failure", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    await expect(make(failing).listAlbums()).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
      retryable: true,
    });
  });

  it("times out a hung request", async () => {
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    await expect(make(hanging, 1000).listAlbums()).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
  }, 5000);

  it("returns image bytes with their mime type", async () => {
    const fake = fakeImmich();
    const image = await make(fake.fetch).thumbnail(IDS.beach, "thumbnail");
    expect(image.mimeType).toBe("image/webp");
    expect([...image.data]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(fake.calls[0].search.get("size")).toBe("thumbnail");
    expect(fake.calls[0].headers.get("accept")).toBe("image/*");
  });

  it("refuses an image over the size cap, by header or by body", async () => {
    const fake = fakeImmich();
    const path = `/api/assets/${IDS.beach}/thumbnail`;
    fake.respond(
      "GET",
      path,
      () =>
        new Response("x", {
          headers: { "content-type": "image/jpeg", "content-length": String(MAX_IMAGE_BYTES + 1) },
        }),
    );
    await expect(make(fake.fetch).thumbnail(IDS.beach, "preview")).rejects.toBeInstanceOf(
      ImmichMcpError,
    );
    fake.respond(
      "GET",
      path,
      () =>
        new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), {
          headers: { "content-type": "image/jpeg" },
        }),
    );
    await expect(make(fake.fetch).thumbnail(IDS.beach, "preview")).rejects.toThrow(/byte limit/);
  });
});
