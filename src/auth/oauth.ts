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
import { createKeyWithPassword } from "./immichLogin.js";
import { CREATED_PERMISSIONS, REQUIRED_PERMISSIONS, errorPage, signInPage } from "./page.js";
import { Sealer, sha256 } from "./seal.js";

/**
 * The OAuth 2.1 authorization server an MCP client signs in through, and the
 * bearer check in front of `/mcp`.
 *
 * Immich's API takes no OAuth tokens, only API keys, so signing in means
 * getting this server a read-only Immich API key. Either the person types
 * their Immich email and password into the page at `/authorize` and the
 * server makes the key with one login (`immichLogin.ts`; the password is
 * dropped after it), or they create a key themselves and paste it.
 *
 * Nothing is stored. A client id is its sealed registration, and a token is
 * the sealed API key plus an expiry, so the container keeps no database. The
 * cost is that a token cannot be revoked here: deleting the key in Immich is
 * the revocation, and it takes effect at the next refresh at the latest.
 */

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 90 * 24 * 60 * 60;
/** However often it is refreshed, a sign-in ends after this long and the key is pasted again. */
const SIGN_IN_MAX_AGE_S = 365 * 24 * 60 * 60;
const CODE_TTL_S = 60;
const SIGN_IN_TTL_S = 10 * 60;
const MAX_PENDING_CODES = 1000;
/**
 * Key checks per minute: each one is a call to Immich. The per-address budget
 * is what stops one caller from using up everyone's; the total protects Immich.
 */
const MAX_KEY_CHECKS_PER_MINUTE = 60;
const MAX_KEY_CHECKS_PER_ADDRESS = 10;
/**
 * Wrong passwords allowed for one account before it has to wait. Immich sees
 * every attempt as coming from this server, so it cannot do this itself. It
 * only holds back this form: signing in to Immich directly is unaffected.
 */
const MAX_FAILED_PASSWORDS = 5;
const FAILED_PASSWORD_WINDOW_MS = 15 * 60_000;
const MAX_BODY_BYTES = 16 * 1024;

const SCOPE = "photos.read";
const CLAUDE_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];
/**
 * What a key may hold on top of the required permissions: reads of the photo
 * library only. Reads of sessions, API keys or shared links are left out on
 * purpose, since a token carries the key.
 */
const ACCEPTED_PERMISSIONS = new Set([
  ...REQUIRED_PERMISSIONS,
  "asset.statistics",
  "album.statistics",
  "person.statistics",
  "face.read",
  "map.read",
  "memory.read",
  "stack.read",
  "tag.read",
  "timeline.read",
]);

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

interface Grant {
  /** The Immich API key. */
  k: string;
  ci: string;
  /** When the key was pasted; carried through every refresh. */
  iat: number;
}

interface TokenPayload extends Grant {
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

/**
 * Who is asking, for rate limiting only. Behind a reverse proxy the last
 * X-Forwarded-For entry is the address the proxy saw, which a caller cannot
 * choose; earlier entries are whatever the caller sent. Without a proxy the
 * header is the caller's to invent, and the total budget is the only limit.
 */
function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",").pop()?.trim() || "direct";
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
    if (!url || url.hash || url.username || url.password) return false;
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

  let keyChecks: Array<{ at: number; address: string }> = [];
  const keyCheckAllowed = (address: string): boolean => {
    const cutoff = now() - 60_000;
    keyChecks = keyChecks.filter((check) => check.at > cutoff);
    if (keyChecks.length >= MAX_KEY_CHECKS_PER_MINUTE) return false;
    const mine = keyChecks.filter((check) => check.address === address).length;
    if (mine >= MAX_KEY_CHECKS_PER_ADDRESS) return false;
    keyChecks.push({ at: now(), address });
    return true;
  };

  /**
   * Password attempts per account that count against it: wrong ones, and ones
   * still waiting on Immich. Counting an attempt before the call is what stops
   * a burst of simultaneous guesses from all passing the check together.
   */
  let passwordAttempts: Array<{ at: number; account: string }> = [];
  const attemptsFor = (account: string): number => {
    const cutoff = now() - FAILED_PASSWORD_WINDOW_MS;
    passwordAttempts = passwordAttempts.filter((attempt) => attempt.at > cutoff);
    return passwordAttempts.filter((attempt) => attempt.account === account).length;
  };

  /**
   * Keys this server creates are named for the app and for its registration, so
   * signing in again from the same registration replaces its key, and a second
   * registration with the same name (the same app on another computer, or
   * someone else's client calling itself "Claude") never removes it.
   */
  const keyPrefixFor = (clientName: string) =>
    `Immich MCP (${
      clientName
        .replace(/[^\p{L}\p{N} ._-]/gu, "")
        .trim()
        .slice(0, 40) || "app"
    } · `;
  const keyNameFor = (clientName: string, clientHash: string) =>
    `${keyPrefixFor(clientName)}${clientHash.slice(0, 6)})`;

  const looksLikeKey = (apiKey: string) => /^[\x21-\x7e]{8,200}$/.test(apiKey);

  /** Asks Immich about a key. `undefined` means it is a usable read-only key. */
  const keyProblem = async (
    apiKey: string,
  ): Promise<{ kind: "rejected" | "unreachable"; message: string } | undefined> => {
    if (!looksLikeKey(apiKey)) {
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
    const excess = permissions.filter((p) => !ACCEPTED_PERMISSIONS.has(p));
    if (excess.length > 0) {
      const shown = excess.slice(0, 5).join(", ") + (excess.length > 5 ? ", …" : "");
      return {
        kind: "rejected",
        message: `That key allows more than this needs (${shown}). Create one with only: ${REQUIRED_PERMISSIONS.join(", ")}.`,
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

  const issueTokens = ({ k, ci, iat }: Grant): Response => {
    const at = seconds();
    const grant: Grant = { k, ci, iat };
    return json({
      access_token: sealer.seal("access", { ...grant, exp: at + ACCESS_TTL_S }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: sealer.seal("refresh", {
        ...grant,
        exp: Math.min(at + REFRESH_TTL_S, iat + SIGN_IN_MAX_AGE_S),
      }),
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
      passwordSignIn: config.passwordSignIn,
      request: sealer.seal("sign-in", signIn),
    });
  };

  const authorizeSubmit = async (request: Request): Promise<Response> => {
    // A browser always sends Origin on a form POST; only this server's own page may post here.
    // "null" is what a browser sends when a referrer policy or privacy mode hides the origin;
    // Sec-Fetch-Site, which a page cannot forge, then says whether it was this site.
    const origin = request.headers.get("origin");
    const sameSite =
      origin === null ||
      origin === issuer ||
      (origin === "null" && request.headers.get("sec-fetch-site") === "same-origin");
    if (!sameSite) {
      return errorPage("This form can only be submitted from the sign-in page.", 403);
    }
    const text = await readBody(request);
    const form = new URLSearchParams(text ?? "");
    const sealed = form.get("request") ?? "";
    const signIn = sealer.open<SignInRequest>("sign-in", sealed);
    if (!signIn || signIn.exp <= seconds()) {
      return errorPage("This sign-in page expired. Go back to the app and connect again.");
    }
    const email = (form.get("email") ?? "").trim();
    const again = (error: string, status: number) =>
      signInPage({
        clientName: signIn.n,
        redirectUri: signIn.ru,
        immichUrl: immich.publicUrl,
        request: sealed,
        passwordSignIn: config.passwordSignIn,
        email,
        error,
        status,
      });

    let apiKey = (form.get("api_key") ?? "").trim();
    const method = form.get("method") ?? (apiKey ? "key" : "password");
    if (method === "password") {
      if (!config.passwordSignIn) return again("Signing in with a password is turned off.", 400);
      const password = form.get("password") ?? "";
      if (!/^\S+@\S+$/.test(email) || email.length > 254 || !password || password.length > 1024) {
        return again("Enter your Immich email and password.", 400);
      }
      const account = email.toLowerCase();
      if (attemptsFor(account) >= MAX_FAILED_PASSWORDS) {
        return again("Too many wrong passwords for this account. Wait 15 minutes.", 429);
      }
      const address = clientAddress(request);
      if (!keyCheckAllowed(address)) {
        return again("Too many attempts right now. Wait a minute.", 429);
      }
      // Before touching Immich: a code must be issuable, or a key would be made for nothing.
      dropExpiredCodes();
      if (codes.size >= MAX_PENDING_CODES) return again("Too busy right now. Wait a minute.", 503);

      const attempt = { at: now(), account };
      passwordAttempts.push(attempt);
      const result = await createKeyWithPassword(
        { baseUrl: immich.baseUrl, timeoutMs: immich.timeoutMs, fetch: options.fetch },
        { email, password },
        {
          name: keyNameFor(signIn.n, signIn.ci),
          permissions: CREATED_PERMISSIONS,
          // Older than any sign-in can last, so nothing can still be using it.
          expired: {
            prefix: keyPrefixFor(signIn.n),
            before: new Date(now() - SIGN_IN_MAX_AGE_S * 1000).toISOString(),
          },
        },
        /^[0-9a-fA-F:.]{3,45}$/.test(address) ? address : undefined,
      );
      // Only a wrong password stays on the account's count.
      if (!result.ok && result.wrongPassword) {
        attempt.at = now();
      } else {
        passwordAttempts = passwordAttempts.filter((entry) => entry !== attempt);
      }
      if (!result.ok) return again(result.message, result.kind === "unreachable" ? 502 : 400);
      // The same check a pasted key gets, so both ways in agree on what a usable key is.
      const problem = await keyProblem(result.apiKey);
      if (problem) return again(problem.message, problem.kind === "unreachable" ? 502 : 400);
      apiKey = result.apiKey;
    } else {
      // Decided without calling Immich, so it costs nothing from the budget below.
      if (!looksLikeKey(apiKey)) return again("That does not look like an Immich API key.", 400);
      if (!keyCheckAllowed(clientAddress(request))) {
        return again("Too many attempts right now. Wait a minute.", 429);
      }
      const problem = await keyProblem(apiKey);
      if (problem) return again(problem.message, problem.kind === "unreachable" ? 502 : 400);
    }

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
        return issueTokens({ k: pending.apiKey, ci, iat: seconds() });
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
        return issueTokens({ k: refresh.k, ci, iat: refresh.iat });
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
