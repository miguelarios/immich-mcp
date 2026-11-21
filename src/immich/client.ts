import { ImmichMcpError, InputError, NotFoundError } from "../errors.js";
import type {
  Album,
  ApiKeyInfo,
  Asset,
  ImageBytes,
  MetadataSearchRequest,
  OcrLine,
  PeoplePage,
  PersonRef,
  SearchResponse,
  SmartSearchRequest,
  SuggestionType,
  ThumbnailSize,
} from "./types.js";

type Fetch = typeof globalThis.fetch;

/** Largest image this server will pass to a model. Immich previews are ~0.1–0.5 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * A thin, typed client over the Immich REST API.
 *
 * It holds no state beyond configuration, so one instance is shared by every
 * MCP session. All calls are reads: the API key may be full-access, but this
 * client only ever issues GETs and the search POSTs (which read).
 */
export interface ImmichClientConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export class ImmichClient {
  private readonly fetchImpl: Fetch;

  constructor(
    private readonly config: ImmichClientConfig,
    fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  /** The key this client calls with: its name and what it is allowed to do. */
  currentApiKey(): Promise<ApiKeyInfo> {
    return this.json("GET", "/api-keys/me");
  }

  smartSearch(body: SmartSearchRequest): Promise<SearchResponse> {
    return this.json("POST", "/search/smart", body);
  }

  metadataSearch(body: MetadataSearchRequest): Promise<SearchResponse> {
    return this.json("POST", "/search/metadata", body);
  }

  getAsset(id: string): Promise<Asset> {
    return this.json("GET", `/assets/${encodeURIComponent(id)}`);
  }

  getAssetOcr(id: string): Promise<OcrLine[]> {
    return this.json("GET", `/assets/${encodeURIComponent(id)}/ocr`);
  }

  /** Albums the asset belongs to. */
  getAlbumsForAsset(assetId: string): Promise<Album[]> {
    return this.json("GET", `/albums?assetId=${encodeURIComponent(assetId)}`);
  }

  listAlbums(): Promise<Album[]> {
    return this.json("GET", "/albums");
  }

  /** Named people whose name matches; Immich matches accent- and case-insensitively. */
  searchPeople(name: string): Promise<PersonRef[]> {
    return this.json("GET", `/search/person?name=${encodeURIComponent(name)}&withHidden=false`);
  }

  listPeople(page: number, size: number): Promise<PeoplePage> {
    return this.json("GET", `/people?page=${page}&size=${size}&withHidden=false`);
  }

  suggestions(type: SuggestionType): Promise<string[]> {
    return this.json("GET", `/search/suggestions?type=${encodeURIComponent(type)}`);
  }

  async thumbnail(id: string, size: ThumbnailSize): Promise<ImageBytes> {
    const response = await this.request(
      "GET",
      `/assets/${encodeURIComponent(id)}/thumbnail?size=${size}`,
      undefined,
      "image/*",
    );
    const mimeType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith("image/")) {
      await response.body?.cancel().catch(() => undefined);
      throw new ImmichMcpError(
        "UPSTREAM_ERROR",
        `Immich returned "${mimeType || "no content type"}" for the ${size} image, not an image.`,
      );
    }
    const tooBig = (bytes: number) =>
      new ImmichMcpError(
        "UPSTREAM_ERROR",
        `The ${size} image is over the ${MAX_IMAGE_BYTES}-byte limit (${bytes}+ bytes).`,
      );
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw tooBig(declared);
    }
    return { mimeType, data: await readCapped(response, MAX_IMAGE_BYTES, tooBig) };
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body, "application/json");
    return (await response.json()) as T;
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    accept: string,
  ): Promise<Response> {
    const url = `${this.config.baseUrl}/api${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          "x-api-key": this.config.apiKey,
          accept,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ImmichMcpError(
          "TIMEOUT",
          `Immich did not answer within ${this.config.timeoutMs} ms.`,
          true,
        );
      }
      const cause = err instanceof Error ? err.message : String(err);
      throw new ImmichMcpError("CONNECTION_FAILED", `Could not reach Immich: ${cause}`, true);
    }

    if (response.ok) return response;
    throw await toHttpError(response);
  }
}

/**
 * Reads a body with a running byte count, aborting as soon as it passes `max`.
 * The Content-Length check alone does not bound memory: a chunked response has
 * none, and `arrayBuffer()` would buffer all of it before any check ran.
 */
async function readCapped(
  response: Response,
  max: number,
  tooBig: (bytes: number) => Error,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooBig(total);
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

async function upstreamMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    const message = parsed.message;
    if (Array.isArray(message)) return message.join("; ");
    if (typeof message === "string") return message;
  } catch {
    // not JSON; fall through
  }
  return text.slice(0, 300) || response.statusText;
}

async function toHttpError(response: Response): Promise<ImmichMcpError> {
  const message = await upstreamMessage(response);
  switch (response.status) {
    case 401:
      return new ImmichMcpError("AUTH_FAILED", `Immich rejected the API key: ${message}`);
    case 403:
      return new ImmichMcpError(
        "FORBIDDEN",
        `The API key lacks a permission for this call: ${message}`,
      );
    case 404:
      return new NotFoundError(message);
    case 400:
      // Immich answers 400, not 404, for an asset that does not exist or is not visible.
      if (/not found|no .*access/i.test(message)) return new NotFoundError(message);
      return new InputError(`Immich rejected the request: ${message}`);
    default:
      return new ImmichMcpError(
        "UPSTREAM_ERROR",
        `Immich answered ${response.status}: ${message}`,
        response.status >= 500 || response.status === 429,
      );
  }
}
