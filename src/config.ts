import { ConfigurationError } from "./errors.js";

export interface ImmichConfig {
  /** Server origin the API is called on, without a trailing slash or `/api`. */
  baseUrl: string;
  /** The one key every call uses. Absent with `IMMICH_MCP_AUTH=oauth`, where each caller brings one. */
  apiKey?: string;
  /** Origin used for the links handed back to the user (`<publicUrl>/photos/<id>`). */
  publicUrl: string;
  /** IANA zone that bare dates (`2024-06-01`) are read in. */
  timeZone: string;
  /** Per-request timeout for calls to Immich. */
  timeoutMs: number;
}

type Env = Record<string, string | undefined>;

function normalizeOrigin(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigurationError(`${name} must be a URL like https://photos.example.com`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(`${name} must use http or https, got "${url.protocol}"`);
  }
  // Accept the value people copy from the docs (".../api") as well as the bare origin.
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${url.origin}${path}`;
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the server configuration from the environment.
 *
 * - `IMMICH_URL` (required) — e.g. `https://photos.example.com`; a trailing `/api` is accepted
 * - `IMMICH_API_KEY` (required unless `requireApiKey` is false) — needs at least `asset.read`,
 *   `asset.view`, `person.read`, `album.read`
 * - `IMMICH_PUBLIC_URL` — origin for links returned to the user; defaults to `IMMICH_URL`
 * - `TZ` — zone that bare dates are read in; defaults to UTC
 * - `IMMICH_TIMEOUT_MS` — per-request timeout, default 30000
 */
export function loadConfig(
  env: Env = process.env,
  options: { requireApiKey?: boolean } = {},
): ImmichConfig {
  const requireApiKey = options.requireApiKey ?? true;
  const rawUrl = env.IMMICH_URL?.trim();
  const apiKey = env.IMMICH_API_KEY?.trim();
  const missing = [!rawUrl && "IMMICH_URL", requireApiKey && !apiKey && "IMMICH_API_KEY"].filter(
    Boolean,
  );
  if (missing.length > 0) {
    throw new ConfigurationError(`Missing required environment: ${missing.join(", ")}`);
  }

  const baseUrl = normalizeOrigin("IMMICH_URL", rawUrl as string);
  const publicUrl = env.IMMICH_PUBLIC_URL?.trim()
    ? normalizeOrigin("IMMICH_PUBLIC_URL", env.IMMICH_PUBLIC_URL)
    : baseUrl;

  const timeZone = env.TZ?.trim() || "UTC";
  if (!isValidTimeZone(timeZone)) {
    throw new ConfigurationError(
      `TZ must be an IANA time zone like America/Chicago, got "${timeZone}"`,
    );
  }

  const rawTimeout = (env.IMMICH_TIMEOUT_MS || "30000").trim();
  const timeoutMs = Number(rawTimeout);
  if (!/^\d+$/.test(rawTimeout) || timeoutMs < 1000) {
    throw new ConfigurationError(`IMMICH_TIMEOUT_MS must be a number of milliseconds >= 1000`);
  }

  return {
    baseUrl,
    ...(requireApiKey ? { apiKey: apiKey as string } : {}),
    publicUrl,
    timeZone,
    timeoutMs,
  };
}
