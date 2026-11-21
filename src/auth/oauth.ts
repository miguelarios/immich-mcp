import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { ImmichMcpError } from "../errors.js";
import { ImmichClient } from "../immich/client.js";
import { type AuthConfig, isLoopbackHost } from "./config.js";
import { REQUIRED_PERMISSIONS, errorPage, signInPage } from "./page.js";
import { Sealer, sha256 } from "./seal.js";

/**
 * The OAuth 2.1 authorization server an MCP client signs in through, and the
 * bearer check in front of `/mcp`.
 *
 * Immich's API takes no OAuth tokens, only API keys, so signing in means
 * handing this server a read-only Immich API key. The person creates it in
 * Immich (signed in however they like: password or passkey) and pastes it
 * into the page at `/authorize`; this server never sees an Immich password.
 *
 * Nothing is stored. A client id is its sealed registration, and a token is
 * the sealed API key plus an expiry, so the container keeps no database. The
 * cost is that a token cannot be revoked here: deleting the key in Immich is
 * the revocation, and it takes effect at the next refresh at the latest.
 */

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 90 * 24 * 60 * 60;
const CODE_TTL_S = 60;
const SIGN_IN_TTL_S = 10 * 60;
const MAX_PENDING_CODES = 1000;
/** Key checks per minute across all callers: each one is a call to Immich. */
const MAX_KEY_CHECKS_PER_MINUTE = 30;
const MAX_BODY_BYTES = 16 * 1024;

const SCOPE = "photos.read";
const CLAUDE_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];
/** A key may hold any of these on top of the required ones; anything else can change the library. */
const READ_ONLY_PERMISSION = /\.(read|view|statistics)$/;

interface ClientRecord {
  /** Registered redirect URIs. */
  r: string[];
  /** Client name, shown on the sign-in page. */
  n: string;
}

interface SignInRequest {
  /** Hash of the client id. */
  ci: string;
  n: string;
  ru: string;
  /** PKCE S256 challenge. */
  cc: string;
  st?: string;
  exp: number;
}

interface PendingCode {
  ci: string;
  ru: string;
  cc: string;
  apiKey: string;
  exp: number;
}

interface TokenPayload {
  /** The Immich API key. */
  k: string;
  ci: string;
  exp: number;
}

export interface OAuthServerOptions {
  config: AuthConfig;
  immich: { baseUrl: string; publicUrl: string; timeoutMs: number };
  fetch?: typeof globalThis.fetch;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

export interface OAuthServer {
  /** Answers the discovery, registration, sign-in and token routes; `undefined` for any other path. */
  routes(request: Request): Promise<Response | undefined>;
  /** The caller of `/mcp`, or the `401` challenge to return. */
  authenticate(request: Request): Promise<AuthInfo | Response>;
}

/** The Immich API key a verified request carries. */
export function apiKeyOf(authInfo: AuthInfo | undefined): string {
  const key = authInfo?.extra?.apiKey;
  if (typeof key !== "string") throw new Error("Request reached a handler without a signed-in key");
  return key;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS, "cache-control": "no-store" } });
}

function oauthError(status: number, error: string, description: string): Response {
  return json({ error, error_description: description }, status);
}

async function readBody(request: Request): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/#.*$/, "").replace(/\/$/, "");
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isLoopbackRedirect(url: URL): boolean {
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/** Exact match, except that a loopback redirect may come back on another port (RFC 8252 §7.3). */
function sameRedirect(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const a = parseUrl(registered);
  const b = parseUrl(requested);
  return (
    a !== undefined &&
    b !== undefined &&
    isLoopbackRedirect(a) &&
    isLoopbackRedirect(b) &&
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search
  );
}

export function createOAuthServer(options: OAuthServerOptions): OAuthServer {
  const { config, immich } = options;
  const now = options.now ?? Date.now;
  const seconds = () => Math.floor(now() / 1000);
  const sealer = new Sealer(config.secret);

  const issuer = config.publicUrl;
  const resource = `${issuer}/mcp`;
  const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;
  const acceptedResources = new Set([issuer, resource]);

  const protectedResourceMetadata = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "Immich Photos",
  };
  const authorizationServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  };

  const redirectAllowed = (uri: string): boolean => {
    const url = parseUrl(uri);
    if (!url || url.hash) return false;
    return (
      isLoopbackRedirect(url) ||
      CLAUDE_REDIRECT_URIS.includes(uri) ||
      config.redirectUris.includes(uri)
    );
  };

  const codes = new Map<string, PendingCode>();
  const dropExpiredCodes = () => {
    const at = seconds();
    for (const [id, code] of codes) if (code.exp <= at) codes.delete(id);
  };

  let keyChecks: number[] = [];
  const keyCheckAllowed = (): boolean => {
    const cutoff = now() - 60_000;
    keyChecks = keyChecks.filter((at) => at > cutoff);
    if (keyChecks.length >= MAX_KEY_CHECKS_PER_MINUTE) return false;
    keyChecks.push(now());
    return true;
  };

  /** Asks Immich about a key. `undefined` means it is a usable read-only key. */
  const keyProblem = async (
    apiKey: string,
  ): Promise<{ kind: "rejected" | "unreachable"; message: string } | undefined> => {
    if (!/^[\x21-\x7e]{8,200}$/.test(apiKey)) {
      return { kind: "rejected", message: "That does not look like an Immich API key." };
    }
    let permissions: string[];
    try {
      const client = new ImmichClient(
        { baseUrl: immich.baseUrl, apiKey, timeoutMs: immich.timeoutMs },
        options.fetch,
      );
      permissions = (await client.currentApiKey()).permissions ?? [];
    } catch (err) {
      if (err instanceof ImmichMcpError && err.code === "AUTH_FAILED") {
        return { kind: "rejected", message: "Immich did not accept that key." };
      }
      return { kind: "unreachable", message: "Could not reach Immich. Try again in a moment." };
    }
    const excess = permissions.filter((p) => !READ_ONLY_PERMISSION.test(p));
    if (excess.length > 0) {
      const shown = excess.slice(0, 5).join(", ") + (excess.length > 5 ? ", …" : "");
      return {
        kind: "rejected",
        message: `That key can do more than read (${shown}). Create one with only: ${REQUIRED_PERMISSIONS.join(", ")}.`,
      };
    }
    const missing = REQUIRED_PERMISSIONS.filter((p) => !permissions.includes(p));
    if (missing.length > 0) {
      return {
        kind: "rejected",
        message: `That key is missing: ${missing.join(", ")}. Edit it in Immich or create a new one.`,
      };
    }
    return undefined;
  };

  const issueTokens = (grant: { k: string; ci: string }): Response => {
    const at = seconds();
    return json({
      access_token: sealer.seal("access", { ...grant, exp: at + ACCESS_TTL_S }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: sealer.seal("refresh", { ...grant, exp: at + REFRESH_TTL_S }),
      scope: SCOPE,
    });
  };

  const register = async (request: Request): Promise<Response> => {
    const text = await readBody(request);
    let body: { redirect_uris?: unknown; client_name?: unknown } | undefined;
    try {
      body = text === undefined ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!body || typeof body !== "object") {
      return oauthError(400, "invalid_client_metadata", "Expected a JSON client registration.");
    }
    const uris = body.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.length > 5 ||
      !uris.every((uri): uri is string => typeof uri === "string" && uri.length <= 300)
    ) {
      return oauthError(400, "invalid_redirect_uri", "redirect_uris must list one to five URIs.");
    }
    const refused = uris.filter((uri) => !redirectAllowed(uri));
    if (refused.length > 0) {
      return oauthError(
        400,
        "invalid_redirect_uri",
        `This server only connects to known clients; not allowed: ${refused.join(", ")}`,
      );
    }
    const name =
      typeof body.client_name === "string" && body.client_name.trim()
        ? body.client_name.trim().slice(0, 80)
        : "An MCP client";
    const record: ClientRecord = { r: uris, n: name };
    return json(
      {
        client_id: sealer.seal("client", record),
        client_id_issued_at: seconds(),
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  };

  const redirectBack = (redirectUri: string, params: Record<string, string | undefined>) => {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    url.searchParams.set("iss", issuer);
    return new Response(null, {
      status: 303,
      headers: { location: url.href, "cache-control": "no-store" },
    });
  };

  const authorizeForm = (request: Request): Response => {
    const query = new URL(request.url).searchParams;
    const clientId = query.get("client_id") ?? "";
    const redirectUri = query.get("redirect_uri") ?? "";
    const client = sealer.open<ClientRecord>("client", clientId);
    if (!client) {
      return errorPage("This app is not registered with this server. Connect again from the app.");
    }
    if (!client.r.some((uri) => sameRedirect(uri, redirectUri)) || !redirectAllowed(redirectUri)) {
      return errorPage("The app asked to return to an address it did not register.");
    }

    // From here the client is known, so problems go back to it rather than to the person.
    const state = query.get("state") ?? undefined;
    const refuse = (error: string, description: string) =>
      redirectBack(redirectUri, { error, error_description: description, state });
    if (query.get("response_type") !== "code") {
      return refuse("unsupported_response_type", "Only response_type=code is supported.");
    }
    const challenge = query.get("code_challenge") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || query.get("code_challenge_method") !== "S256") {
      return refuse("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    const requested = query.get("resource");
    if (requested !== null && !acceptedResources.has(withoutTrailingSlash(requested))) {
      return refuse("invalid_target", `This server only issues tokens for ${resource}.`);
    }

    const signIn: SignInRequest = {
      ci: sha256(clientId),
      n: client.n,
      ru: redirectUri,
      cc: challenge,
      st: state,
      exp: seconds() + SIGN_IN_TTL_S,
    };
    return signInPage({
      clientName: client.n,
      redirectUri,
      immichUrl: immich.publicUrl,
      request: sealer.seal("sign-in", signIn),
    });
  };

  const authorizeSubmit = async (request: Request): Promise<Response> => {
    // A browser always sends Origin on a form POST; only this server's own page may post here.
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== issuer) {
      return errorPage("This form can only be submitted from the sign-in page.", 403);
    }
    const text = await readBody(request);
    const form = new URLSearchParams(text ?? "");
    const sealed = form.get("request") ?? "";
    const signIn = sealer.open<SignInRequest>("sign-in", sealed);
    if (!signIn || signIn.exp <= seconds()) {
      return errorPage("This sign-in page expired. Go back to the app and connect again.");
    }
    const again = (error: string, status: number) =>
      signInPage({
        clientName: signIn.n,
        redirectUri: signIn.ru,
        immichUrl: immich.publicUrl,
        request: sealed,
        error,
        status,
      });

    if (!keyCheckAllowed()) return again("Too many attempts right now. Wait a minute.", 429);
    const apiKey = (form.get("api_key") ?? "").trim();
    const problem = await keyProblem(apiKey);
    if (problem) return again(problem.message, problem.kind === "unreachable" ? 502 : 400);

    dropExpiredCodes();
    if (codes.size >= MAX_PENDING_CODES) return again("Too busy right now. Wait a minute.", 503);
    const code = randomBytes(32).toString("base64url");
    codes.set(sha256(code), {
      ci: signIn.ci,
      ru: signIn.ru,
      cc: signIn.cc,
      apiKey,
      exp: seconds() + CODE_TTL_S,
    });
    return redirectBack(signIn.ru, { code, state: signIn.st });
  };

  const token = async (request: Request): Promise<Response> => {
    const text = await readBody(request);
    const form = new URLSearchParams(text ?? "");
    const clientId = form.get("client_id") ?? "";
    if (!sealer.open<ClientRecord>("client", clientId)) {
      return oauthError(401, "invalid_client", "Unknown client_id.");
    }
    const ci = sha256(clientId);
    const requested = form.get("resource");
    if (requested !== null && !acceptedResources.has(withoutTrailingSlash(requested))) {
      return oauthError(400, "invalid_target", `This server only issues tokens for ${resource}.`);
    }

    switch (form.get("grant_type")) {
      case "authorization_code": {
        const id = sha256(form.get("code") ?? "");
        const pending = codes.get(id);
        // Single use: the code is gone whether or not the rest checks out.
        codes.delete(id);
        const redirectUri = form.get("redirect_uri");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest();
        if (
          !pending ||
          pending.exp <= seconds() ||
          pending.ci !== ci ||
          (redirectUri !== null && redirectUri !== pending.ru) ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          !timingSafeEqual(challenge, Buffer.from(pending.cc, "base64url"))
        ) {
          return oauthError(400, "invalid_grant", "The authorization code is not valid.");
        }
        return issueTokens({ k: pending.apiKey, ci });
      }
      case "refresh_token": {
        const refresh = sealer.open<TokenPayload>("refresh", form.get("refresh_token") ?? "");
        if (!refresh || refresh.exp <= seconds() || refresh.ci !== ci) {
          return oauthError(400, "invalid_grant", "The refresh token is not valid.");
        }
        // The hourly refresh is where a key deleted or widened in Immich stops working.
        // An unreachable Immich is not a verdict on the key, so the session carries on.
        const problem = await keyProblem(refresh.k);
        if (problem?.kind === "rejected") {
          return oauthError(400, "invalid_grant", "The Immich API key is no longer accepted.");
        }
        return issueTokens({ k: refresh.k, ci });
      }
      default:
        return oauthError(
          400,
          "unsupported_grant_type",
          "Use authorization_code or refresh_token.",
        );
    }
  };

  const routes = async (request: Request): Promise<Response | undefined> => {
    const { pathname } = new URL(request.url);
    const method = request.method;

    let document: unknown;
    if (
      pathname === "/.well-known/oauth-protected-resource" ||
      pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      document = protectedResourceMetadata;
    } else if (
      pathname === "/.well-known/oauth-authorization-server" ||
      pathname === "/.well-known/oauth-authorization-server/mcp"
    ) {
      document = authorizationServerMetadata;
    }
    const isEndpoint = pathname === "/register" || pathname === "/token";
    if ((document || isEndpoint) && method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (document) {
      if (method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
      return Response.json(document, {
        headers: { ...CORS, "cache-control": "public, max-age=3600" },
      });
    }

    if (isEndpoint) {
      if (method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      return pathname === "/register" ? register(request) : token(request);
    }
    if (pathname === "/authorize") {
      if (method === "GET") return authorizeForm(request);
      if (method === "POST") return authorizeSubmit(request);
      return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
    }
    return undefined;
  };

  const authenticate = requireBearerAuth({
    verifier: {
      verifyAccessToken: async (bearer) => {
        const payload = sealer.open<TokenPayload>("access", bearer);
        if (!payload) throw new OAuthError(OAuthErrorCode.InvalidToken, "Unknown access token.");
        if (payload.exp <= seconds()) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "Token has expired");
        }
        return {
          token: bearer,
          clientId: payload.ci,
          scopes: [SCOPE],
          expiresAt: payload.exp,
          resource: new URL(resource),
          // `sub` identifies the caller without being the key itself.
          extra: { apiKey: payload.k, sub: sha256(payload.k) },
        };
      },
    },
    expectedResource: new URL(resource),
    resourceMetadataUrl,
  });

  return { routes, authenticate };
}
