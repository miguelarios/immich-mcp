import { ConfigurationError } from "../errors.js";

export interface AuthConfig {
  /** The origin clients reach this server on, e.g. `https://photos-mcp.example.com`. */
  publicUrl: string;
  /** Seals client ids and tokens. Changing it signs everyone out. */
  secret: string;
  /** Redirect URIs admitted besides the Claude callbacks and loopback. */
  redirectUris: string[];
}

type Env = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * Reads the sign-in configuration from the environment.
 *
 * - `IMMICH_MCP_AUTH` — `none` (default: one `IMMICH_API_KEY` for every caller)
 *   or `oauth` (each caller signs in with their own Immich API key)
 * - `IMMICH_MCP_PUBLIC_URL` — the origin clients use; https unless loopback
 * - `IMMICH_MCP_SECRET` — at least 32 characters, e.g. `openssl rand -base64 48`
 * - `IMMICH_MCP_OAUTH_REDIRECT_URIS` — comma-separated extra redirect URIs
 *
 * Returns `undefined` when sign-in is off.
 */
export function loadAuthConfig(env: Env = process.env): AuthConfig | undefined {
  const mode = (env.IMMICH_MCP_AUTH || "none").trim().toLowerCase();
  if (mode === "none") return undefined;
  if (mode !== "oauth") {
    throw new ConfigurationError(
      `IMMICH_MCP_AUTH must be "none" or "oauth", got "${env.IMMICH_MCP_AUTH}"`,
    );
  }

  const rawUrl = env.IMMICH_MCP_PUBLIC_URL?.trim();
  const secret = env.IMMICH_MCP_SECRET?.trim();
  const missing = [!rawUrl && "IMMICH_MCP_PUBLIC_URL", !secret && "IMMICH_MCP_SECRET"].filter(
    Boolean,
  );
  if (missing.length > 0) {
    throw new ConfigurationError(`IMMICH_MCP_AUTH=oauth also needs: ${missing.join(", ")}`);
  }
  if (env.IMMICH_API_KEY?.trim()) {
    throw new ConfigurationError(
      "Unset IMMICH_API_KEY when IMMICH_MCP_AUTH=oauth: each person signs in with their own key.",
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl as string);
  } catch {
    throw new ConfigurationError(
      "IMMICH_MCP_PUBLIC_URL must be a URL like https://photos-mcp.example.com",
    );
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigurationError(
      "IMMICH_MCP_PUBLIC_URL must be an origin without a path: OAuth discovery lives at its root.",
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new ConfigurationError("IMMICH_MCP_PUBLIC_URL must use https (http only on loopback).");
  }
  if ((secret as string).length < 32) {
    throw new ConfigurationError("IMMICH_MCP_SECRET must be at least 32 characters.");
  }

  const redirectUris = (env.IMMICH_MCP_OAUTH_REDIRECT_URIS || "")
    .split(",")
    .map((uri) => uri.trim())
    .filter(Boolean);
  for (const uri of redirectUris) {
    if (!URL.canParse(uri)) {
      throw new ConfigurationError(`IMMICH_MCP_OAUTH_REDIRECT_URIS has an invalid URI: "${uri}"`);
    }
  }

  return { publicUrl: url.origin, secret: secret as string, redirectUris };
}
