/**
 * Sign-in: the OAuth routes, the bearer check in front of /mcp, and the rule
 * that two people connected at once never share a library.
 */
import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadAuthConfig } from "../auth/config.js";
import { LibraryPool } from "../auth/libraries.js";
import { apiKeyOf, createOAuthServer } from "../auth/oauth.js";
import { Sealer } from "../auth/seal.js";
import { loadConfig } from "../config.js";
import { ConfigurationError } from "../errors.js";
import { ImmichClient } from "../immich/client.js";
import { PhotoLibrary } from "../library/PhotoLibrary.js";
import { createServer } from "../main.js";
import { createHttpHandler, serveHttp } from "../mcp/tools.js";
import { BASE, READ_PERMISSIONS, fakeImmich } from "./fakeImmich.js";

const PUBLIC = "http://localhost:3000";
const SECRET = "0123456789abcdefghijklmnopqrstuvwxyzABCD";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const ADA_KEY = "ada-key-0000000000000000";
const JOSE_KEY = "jose-key-000000000000000";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function setup() {
  const fake = fakeImmich();
  fake.apiKeys.set(ADA_KEY, READ_PERMISSIONS);
  fake.apiKeys.set(JOSE_KEY, [...READ_PERMISSIONS, "album.statistics"]);
  // Starts at the real time: the SDK checks token expiry against the real clock.
  const clock = { ms: Date.now() };
  const oauth = createOAuthServer({
    config: { publicUrl: PUBLIC, secret: SECRET, redirectUris: [] },
    immich: { baseUrl: BASE, publicUrl: BASE, timeoutMs: 30_000 },
    fetch: fake.fetch,
    now: () => clock.ms,
  });
  const libraries = new LibraryPool(
    (apiKey) =>
      new PhotoLibrary(new ImmichClient({ baseUrl: BASE, apiKey, timeoutMs: 30_000 }, fake.fetch), {
        publicUrl: BASE,
        timeZone: "America/Chicago",
      }),
  );
  const factory = (ctx: { authInfo?: Parameters<typeof apiKeyOf>[0] }) =>
    createServer(libraries.for(apiKeyOf(ctx.authInfo)));
  const handler = createHttpHandler(factory, { auth: oauth });
  closers.push(() => handler.close());

  const get = (path: string, headers: Record<string, string> = {}) =>
    handler.fetch(new Request(`${PUBLIC}${path}`, { headers }));
  const post = (path: string, body: string, headers: Record<string, string>) =>
    handler.fetch(new Request(`${PUBLIC}${path}`, { method: "POST", body, headers }));
  const postForm = (path: string, fields: Record<string, string>) =>
    post(path, new URLSearchParams(fields).toString(), {
      "content-type": "application/x-www-form-urlencoded",
    });
  const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    post(path, JSON.stringify(body), { "content-type": "application/json", ...headers });

  const register = async (redirectUris = [CLAUDE], name = "Claude") => {
    const response = await postJson("/register", {
      redirect_uris: redirectUris,
      client_name: name,
    });
    return { response, body: (await response.json()) as Record<string, any> };
  };

  /** Opens the sign-in page; returns the sealed request the form posts back. */
  const openSignIn = async (clientId: string, challenge: string, redirectUri = CLAUDE) => {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st-1",
      resource: `${PUBLIC}/mcp`,
    });
    const response = await get(`/authorize?${query}`);
    const html = await response.text();
    return { response, html, request: /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "" };
  };

  /** The whole dance for one person; returns their tokens. */
  const signIn = async (apiKey: string) => {
    const { body: client } = await register();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const { request } = await openSignIn(client.client_id, challenge);
    const submitted = await postForm("/authorize", { request, api_key: apiKey });
    const location = new URL(submitted.headers.get("location") ?? "about:blank");
    const code = location.searchParams.get("code") ?? "";
    const response = await postForm("/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: CLAUDE,
    });
    const tokens = (await response.json()) as Record<string, any>;
    return { clientId: client.client_id as string, verifier, code, location, response, tokens };
  };

  return { fake, clock, oauth, factory, get, postForm, postJson, register, openSignIn, signIn };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0.0.0" },
  },
};
const MCP_HEADERS = { accept: "application/json, text/event-stream" };

describe("discovery and the bearer check", () => {
  it("publishes both metadata documents", async () => {
    const { get } = setup();
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const document = (await (await get(path)).json()) as Record<string, any>;
      expect(document.resource).toBe(`${PUBLIC}/mcp`);
      expect(document.authorization_servers).toEqual([PUBLIC]);
    }
    const server = (await (await get("/.well-known/oauth-authorization-server")).json()) as Record<
      string,
      any
    >;
    expect(server).toMatchObject({
      issuer: PUBLIC,
      authorization_endpoint: `${PUBLIC}/authorize`,
      token_endpoint: `${PUBLIC}/token`,
      registration_endpoint: `${PUBLIC}/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("challenges /mcp without a token, pointing at the metadata", async () => {
    const { postJson } = setup();
    const response = await postJson("/mcp", INITIALIZE, MCP_HEADERS);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("refuses a made-up token, a refresh token, and an expired access token", async () => {
    const { postJson, signIn, clock } = setup();
    const { tokens } = await signIn(ADA_KEY);
    const withToken = (token: string) =>
      postJson("/mcp", INITIALIZE, { ...MCP_HEADERS, authorization: `Bearer ${token}` });

    expect((await withToken("nonsense")).status).toBe(401);
    expect((await withToken(tokens.refresh_token)).status).toBe(401);
    expect((await withToken(tokens.access_token)).status).toBe(200);
    clock.ms += 3601_000;
    expect((await withToken(tokens.access_token)).status).toBe(401);
  });
});

describe("client registration", () => {
  it("accepts the Claude callbacks and loopback", async () => {
    const { register } = setup();
    const { response, body } = await register([CLAUDE, "http://127.0.0.1:53211/callback"]);
    expect(response.status).toBe(201);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_id).toEqual(expect.any(String));
  });

  it.each([
    [["https://evil.example/callback"]],
    [[CLAUDE, "https://evil.example/callback"]],
    [["https://claude.ai.evil.example/api/mcp/auth_callback"]],
    [["http://example.test/callback"]],
    [["http://user@localhost:8080/callback"]],
    [[]],
  ])("refuses redirect URIs %j", async (uris) => {
    const { register } = setup();
    const { response, body } = await register(uris);
    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_redirect_uri");
  });
});

describe("the sign-in page", () => {
  const challenge = createHash("sha256").update("v".repeat(43)).digest("base64url");

  it("names the client and where it returns, with the name escaped", async () => {
    const { register, openSignIn } = setup();
    const { body } = await register([CLAUDE], '<script>alert("x")</script>');
    const { response, html } = await openSignIn(body.client_id, challenge);
    expect(response.status).toBe(200);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("claude.ai");
    expect(html).toContain(`${BASE}/user-settings?isOpen=api-keys`);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("shows an error, not a redirect, for an unknown client or an unregistered return address", async () => {
    const { register, openSignIn } = setup();
    const unknown = await openSignIn("made-up", challenge);
    expect(unknown.response.status).toBe(400);
    expect(unknown.response.headers.get("location")).toBeNull();

    const { body } = await register();
    const elsewhere = await openSignIn(body.client_id, challenge, "https://evil.example/cb");
    expect(elsewhere.response.status).toBe(400);
    expect(elsewhere.response.headers.get("location")).toBeNull();
  });

  it("sends a request without PKCE S256 back to the client as an error", async () => {
    const { register, get } = setup();
    const { body } = await register();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: body.client_id,
      redirect_uri: CLAUDE,
      state: "st-9",
    });
    const response = await get(`/authorize?${query}`);
    const location = new URL(response.headers.get("location") ?? "");
    expect(response.status).toBe(303);
    expect(location.origin + location.pathname).toBe(CLAUDE);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("st-9");
  });

  it("refuses a token request for another resource", async () => {
    const { register, get } = setup();
    const { body } = await register();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: body.client_id,
      redirect_uri: CLAUDE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://other.example/mcp",
    });
    const location = new URL((await get(`/authorize?${query}`)).headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("invalid_target");
  });

  it.each([
    [
      "a key Immich does not know",
      "unknown-key-00000000",
      [] as string[] | undefined,
      "did not accept",
    ],
    ["a full-access key", "all-key-0000000000000", ["all"], "allows more than this needs (all)"],
    [
      "a key that can also delete",
      "write-key-00000000000",
      [...READ_PERMISSIONS, "asset.delete"],
      "allows more than this needs (asset.delete)",
    ],
    [
      "a key that can read sessions",
      "nosy-key-000000000000",
      [...READ_PERMISSIONS, "session.read"],
      "allows more than this needs (session.read)",
    ],
    [
      "a key missing a permission",
      "thin-key-000000000000",
      ["asset.read"],
      "is missing: asset.view",
    ],
    ["something that is not a key", "x y", undefined, "does not look like"],
  ])("refuses %s and keeps the form open", async (_label, key, permissions, message) => {
    const { fake, register, openSignIn, postForm } = setup();
    if (permissions && permissions.length > 0) fake.apiKeys.set(key, permissions);
    const { body } = await register();
    const { request } = await openSignIn(body.client_id, challenge);
    const response = await postForm("/authorize", { request, api_key: key });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain(message);
    expect(html).toContain('name="request"');
    expect(html).not.toContain(key);
  });

  it("accepts the form as a browser sends it, and only from this page", async () => {
    const { register, openSignIn, oauth } = setup();
    const { body } = await register();
    const submit = async (headers: Record<string, string>) => {
      const { request } = await openSignIn(body.client_id, challenge);
      const response = await oauth.routes(
        new Request(`${PUBLIC}/authorize`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams({ request, api_key: ADA_KEY }).toString(),
        }),
      );
      return response?.status;
    };
    expect(await submit({ origin: PUBLIC })).toBe(303);
    // A privacy mode or referrer policy can blank the origin; Sec-Fetch-Site still vouches for it.
    expect(await submit({ origin: "null", "sec-fetch-site": "same-origin" })).toBe(303);
    expect(await submit({ origin: "null" })).toBe(403);
    expect(await submit({ origin: "null", "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await submit({ origin: "https://evil.example", "sec-fetch-site": "same-origin" })).toBe(
      403,
    );
  });

  it("does not let one address use up everyone's attempts", async () => {
    const { fake, register, openSignIn, oauth } = setup();
    const { body } = await register();
    const { request } = await openSignIn(body.client_id, challenge);
    const attempt = async (address: string, key: string) => {
      const response = await oauth.routes(
        new Request(`${PUBLIC}/authorize`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            // The proxy appends the address it saw; what comes before is the caller's claim.
            "x-forwarded-for": `203.0.113.99, ${address}`,
          },
          body: new URLSearchParams({ request, api_key: key }).toString(),
        }),
      );
      return response?.status;
    };
    for (let i = 0; i < 10; i++)
      expect(await attempt("198.51.100.7", "wrong-key-00000000")).toBe(400);
    expect(await attempt("198.51.100.7", "wrong-key-00000000")).toBe(429);
    expect(await attempt("198.51.100.7", ADA_KEY)).toBe(429);
    // Someone else still gets in, and junk that is not key-shaped never reaches Immich.
    expect(await attempt("198.51.100.8", ADA_KEY)).toBe(303);
    const before = fake.callsTo("GET", "/api/api-keys/me").length;
    expect(await attempt("198.51.100.9", "x y")).toBe(400);
    expect(fake.callsTo("GET", "/api/api-keys/me")).toHaveLength(before);
  });

  it("warns against links from someone else and does not vouch for the app's name", async () => {
    const { register, openSignIn } = setup();
    const { body } = await register([CLAUDE], "Claude (official)");
    const { html } = await openSignIn(body.client_id, challenge);
    expect(html).toContain("An app that calls itself <strong>Claude (official)</strong>");
    expect(html).toContain("Only continue if you started this yourself");
  });

  it("refuses a form posted from another site, and an expired page", async () => {
    const { register, openSignIn, postForm, clock, oauth } = setup();
    const { body } = await register();
    const { request } = await openSignIn(body.client_id, challenge);

    const foreign = await oauth.routes(
      new Request(`${PUBLIC}/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
        },
        body: new URLSearchParams({ request, api_key: ADA_KEY }).toString(),
      }),
    );
    expect(foreign?.status).toBe(403);

    clock.ms += 11 * 60_000;
    const late = await postForm("/authorize", { request, api_key: ADA_KEY });
    expect(late.status).toBe(400);
    expect(await late.text()).toContain("expired");
  });
});

describe("tokens", () => {
  it("exchanges the code once, with the right verifier, for tokens that hide the key", async () => {
    const { signIn, postForm } = setup();
    const { location, response, tokens, code, verifier, clientId } = await signIn(ADA_KEY);
    expect(location.origin + location.pathname).toBe(CLAUDE);
    expect(location.searchParams.get("state")).toBe("st-1");
    expect(location.searchParams.get("iss")).toBe(PUBLIC);
    expect(response.status).toBe(200);
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(JSON.stringify(tokens)).not.toContain(ADA_KEY);
    expect(Buffer.from(tokens.access_token, "base64url").toString("latin1")).not.toContain(ADA_KEY);

    const again = await postForm("/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(again.status).toBe(400);
    expect(((await again.json()) as any).error).toBe("invalid_grant");
  });

  it("refuses the code with the wrong verifier, the wrong client, or too late", async () => {
    const { register, openSignIn, postForm, clock } = setup();
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const attempt = async (change: {
      verifier?: string;
      otherClient?: boolean;
      waitMs?: number;
    }) => {
      const { body } = await register();
      const { request } = await openSignIn(body.client_id, challenge);
      const submitted = await postForm("/authorize", { request, api_key: ADA_KEY });
      const code = new URL(submitted.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const clientId = change.otherClient
        ? (await register([CLAUDE], "Other")).body.client_id
        : body.client_id;
      clock.ms += change.waitMs ?? 0;
      return postForm("/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: change.verifier ?? verifier,
        client_id: clientId,
      });
    };
    expect((await attempt({})).status).toBe(200);
    expect((await attempt({ verifier: "w".repeat(43) })).status).toBe(400);
    expect((await attempt({ otherClient: true })).status).toBe(400);
    expect((await attempt({ waitMs: 61_000 })).status).toBe(400);
  });

  it("refreshes while Immich accepts the key, and stops when the key is deleted", async () => {
    const { fake, signIn, postForm, postJson } = setup();
    const { tokens, clientId } = await signIn(ADA_KEY);
    const refresh = (token: string) =>
      postForm("/token", {
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: clientId,
      });

    const renewed = await refresh(tokens.refresh_token);
    expect(renewed.status).toBe(200);
    const next = (await renewed.json()) as Record<string, any>;
    const used = await postJson("/mcp", INITIALIZE, {
      ...MCP_HEADERS,
      authorization: `Bearer ${next.access_token}`,
    });
    expect(used.status).toBe(200);

    // An access token is not a refresh token.
    expect((await refresh(tokens.access_token)).status).toBe(400);

    // Immich being down is not a verdict on the key.
    fake.respond("GET", "/api/api-keys/me", () => new Response("down", { status: 503 }));
    expect((await refresh(next.refresh_token)).status).toBe(200);

    fake.respond("GET", "/api/api-keys/me", () =>
      Response.json({ message: "Invalid API key" }, { status: 401 }),
    );
    const gone = await refresh(next.refresh_token);
    expect(gone.status).toBe(400);
    expect(((await gone.json()) as any).error).toBe("invalid_grant");
  });

  it("ends a sign-in after a year however often it was refreshed", async () => {
    const { signIn, postForm, clock } = setup();
    const { tokens, clientId } = await signIn(ADA_KEY);
    let refreshToken = tokens.refresh_token as string;
    const refresh = () =>
      postForm("/token", {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      });
    for (let month = 0; month < 6; month++) {
      clock.ms += 60 * 24 * 3600_000;
      const response = await refresh();
      expect(response.status).toBe(200);
      refreshToken = ((await response.json()) as any).refresh_token;
    }
    clock.ms += 10 * 24 * 3600_000;
    expect((await refresh()).status).toBe(400);
  });
});

describe("two people connected at once", () => {
  it("each call Immich with their own key and never share cached names", async () => {
    const { fake, factory, oauth, signIn } = setup();
    const http = await serveHttp(factory, {
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: [],
      auth: oauth,
    });
    closers.push(() => http.close());

    const ada = (await signIn(ADA_KEY)).tokens.access_token;
    const jose = (await signIn(JOSE_KEY)).tokens.access_token;

    for (const mode of ["legacy", { pin: "2026-07-28" }] as const) {
      for (const token of [ada, jose, ada]) {
        const client = new Client(
          { name: "auth-test", version: "0.0.0" },
          { versionNegotiation: { mode } },
        );
        await client.connect(
          new StreamableHTTPClientTransport(http.url, {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          }),
        );
        const result = await client.callTool({ name: "list_albums", arguments: { name: "trip" } });
        expect((result.structuredContent as any).albums[0].name).toBe("Beach Trip 2024");
        await client.close();
      }
    }

    // Six calls, but the album list is fetched once per person: Ada's later calls hit her own
    // cache, and José's first call does not reuse hers.
    const keys = fake.callsTo("GET", "/api/albums").map((call) => call.headers.get("x-api-key"));
    expect(keys).toEqual([ADA_KEY, JOSE_KEY]);
  });

  it("does not let one person use another's 2025-era session", async () => {
    const { signIn, postJson } = setup();
    const ada = (await signIn(ADA_KEY)).tokens.access_token;
    const jose = (await signIn(JOSE_KEY)).tokens.access_token;

    const opened = await postJson("/mcp", INITIALIZE, {
      ...MCP_HEADERS,
      authorization: `Bearer ${ada}`,
    });
    const sessionId = opened.headers.get("mcp-session-id") ?? "";
    expect(sessionId).not.toBe("");

    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const headers = {
      ...MCP_HEADERS,
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-06-18",
    };
    const stolen = await postJson("/mcp", list, { ...headers, authorization: `Bearer ${jose}` });
    expect(stolen.status).toBe(404);
    const own = await postJson("/mcp", list, { ...headers, authorization: `Bearer ${ada}` });
    expect(own.status).toBe(200);
  });

  it("keeps one caller to twenty 2025-era sessions, closing the oldest", async () => {
    const { signIn, postJson } = setup();
    const ada = (await signIn(ADA_KEY)).tokens.access_token;
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${ada}` };
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const opened = await postJson("/mcp", INITIALIZE, headers);
      ids.push(opened.headers.get("mcp-session-id") ?? "");
    }
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const use = (id: string) =>
      postJson("/mcp", list, {
        ...headers,
        "mcp-session-id": id,
        "mcp-protocol-version": "2025-06-18",
      });
    expect((await use(ids[0])).status).toBe(404);
    expect((await use(ids[20])).status).toBe(200);
  });
});

describe("Sealer", () => {
  it("opens only what it sealed, for the same purpose and secret", () => {
    const sealer = new Sealer(SECRET);
    const sealed = sealer.seal("access", { k: "value" });
    expect(sealer.open("access", sealed)).toEqual({ k: "value" });
    expect(sealer.open("refresh", sealed)).toBeUndefined();
    expect(new Sealer(`${SECRET}x`).open("access", sealed)).toBeUndefined();
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`;
    expect(sealer.open("access", tampered)).toBeUndefined();
    expect(sealer.open("access", "")).toBeUndefined();
    expect(sealer.seal("access", { k: "value" })).not.toBe(sealed);
  });
});

describe("LibraryPool", () => {
  it("keeps one library per key and drops the least recently used", () => {
    let made = 0;
    const pool = new LibraryPool(() => {
      made += 1;
      return {} as PhotoLibrary;
    }, 2);
    const a = pool.for("a");
    expect(pool.for("a")).toBe(a);
    pool.for("b");
    pool.for("a");
    pool.for("c");
    expect(pool.size).toBe(2);
    expect(pool.for("a")).toBe(a);
    pool.for("b");
    expect(made).toBe(4);
  });
});

describe("loadAuthConfig", () => {
  const oauth = {
    IMMICH_MCP_AUTH: "oauth",
    IMMICH_MCP_PUBLIC_URL: "https://photos-mcp.example.test/",
    IMMICH_MCP_SECRET: SECRET,
  };

  it("is off by default", () => {
    expect(loadAuthConfig({})).toBeUndefined();
    expect(loadAuthConfig({ IMMICH_MCP_AUTH: "none" })).toBeUndefined();
  });

  it("reads the public origin, the secret and extra redirect URIs", () => {
    expect(
      loadAuthConfig({
        ...oauth,
        IMMICH_MCP_OAUTH_REDIRECT_URIS: "https://agent.example.test/callback, ",
      }),
    ).toEqual({
      publicUrl: "https://photos-mcp.example.test",
      secret: SECRET,
      redirectUris: ["https://agent.example.test/callback"],
    });
  });

  it.each([
    [{ IMMICH_MCP_AUTH: "basic" }, 'must be "none" or "oauth"'],
    [{ IMMICH_MCP_AUTH: "oauth" }, "IMMICH_MCP_PUBLIC_URL, IMMICH_MCP_SECRET"],
    [{ ...oauth, IMMICH_MCP_SECRET: "short" }, "at least 32"],
    [{ ...oauth, IMMICH_MCP_SECRET: "a".repeat(40) }, "random characters"],
    [{ ...oauth, IMMICH_MCP_OAUTH_REDIRECT_URIS: "http://agent.example.test/cb" }, "plain http"],
    [{ ...oauth, IMMICH_MCP_PUBLIC_URL: "http://photos-mcp.example.test" }, "must use https"],
    [{ ...oauth, IMMICH_MCP_PUBLIC_URL: "https://example.test/mcp" }, "without a path"],
    [{ ...oauth, IMMICH_API_KEY: "k" }, "Unset IMMICH_API_KEY"],
    [{ ...oauth, IMMICH_MCP_OAUTH_REDIRECT_URIS: "not a uri" }, "invalid URI"],
  ])("rejects %o", (env, message) => {
    expect(() => loadAuthConfig(env)).toThrow(ConfigurationError);
    expect(() => loadAuthConfig(env)).toThrow(message);
  });

  it("lets the Immich config load without a key when sign-in is on", () => {
    const config = loadConfig({ IMMICH_URL: BASE }, { requireApiKey: false });
    expect(config.apiKey).toBeUndefined();
    expect(() => loadConfig({ IMMICH_URL: BASE })).toThrow(
      "Missing required environment: IMMICH_API_KEY",
    );
  });
});
