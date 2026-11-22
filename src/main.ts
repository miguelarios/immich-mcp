import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { loadAuthConfig } from "./auth/config.js";
import { LibraryPool } from "./auth/libraries.js";
import { apiKeyOf, createOAuthServer } from "./auth/oauth.js";
import { loadConfig } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { ImmichClient } from "./immich/client.js";
import { PhotoLibrary } from "./library/PhotoLibrary.js";
import { TOOL_LIST_CACHE_HINT, loadTransportConfig, registerTools, serve } from "./mcp/tools.js";
import { PHOTO_TOOLS } from "./tools/index.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export const INSTRUCTIONS =
  "Search and look at the user's Immich photo library (read-only). " +
  "Pick the search by what the user remembers: what the photo SHOWS -> search_photos; " +
  "text written IN the image (receipt, sign, document, screenshot) -> search_photo_text; " +
  "who/where/when/album/tag/rating/camera/file name -> search_photo_metadata. All three take the same filters " +
  "(people, place, taken, camera, album, tags, rating), given as plain names; list_people, list_albums, list_tags and " +
  "list_cameras show the names a filter accepts. Then use view_photo to see a result before describing it, and get_photo for its details and full text. " +
  "Share a photo's url so the user can open it in Immich.";

/**
 * Builds one server instance around a shared library. Called per request
 * (2026-07-28) or per session (2025-era) over HTTP, so it must not open
 * connections or install process handlers.
 */
export function createServer(library: PhotoLibrary): McpServer {
  const server = new McpServer(
    { name: "immich-mcp", title: "Immich Photos", version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
      cacheHints: { "tools/list": TOOL_LIST_CACHE_HINT },
    },
  );
  registerTools(server, PHOTO_TOOLS, library);
  return server;
}

export async function startServer(): Promise<void> {
  const auth = loadAuthConfig();
  const config = loadConfig(process.env, { requireApiKey: !auth });
  const libraryFor = (apiKey: string) =>
    new PhotoLibrary(new ImmichClient({ ...config, apiKey }), {
      publicUrl: config.publicUrl,
      timeZone: config.timeZone,
    });

  let handle: { close: () => Promise<void> };
  if (auth) {
    if (loadTransportConfig().kind !== "http") {
      throw new ConfigurationError("IMMICH_MCP_AUTH=oauth needs IMMICH_MCP_TRANSPORT=http.");
    }
    // Every caller brings their own key, and gets a library (and name caches) of their own.
    const libraries = new LibraryPool(libraryFor);
    const oauth = createOAuthServer({ config: auth, immich: config });
    handle = await serve((ctx) => createServer(libraries.for(apiKeyOf(ctx.authInfo))), {
      name: "immich-mcp",
      auth: oauth,
    });
    console.error(`[immich-mcp] Sign-in is on; clients connect to ${auth.publicUrl}/mcp`);
  } else {
    const library = libraryFor(config.apiKey as string);
    handle = await serve(() => createServer(library), { name: "immich-mcp" });
  }

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
