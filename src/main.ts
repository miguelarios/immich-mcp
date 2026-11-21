import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { loadConfig } from "./config.js";
import { ImmichClient } from "./immich/client.js";
import { PhotoLibrary } from "./library/PhotoLibrary.js";
import { TOOL_LIST_CACHE_HINT, registerTools, serve } from "./mcp/tools.js";
import { PHOTO_TOOLS } from "./tools/index.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export const INSTRUCTIONS =
  "Search and look at the user's Immich photo library (read-only). " +
  "Pick the search by what the user remembers: what the photo SHOWS -> search_photos; " +
  "text written IN the image (receipt, sign, document, screenshot) -> search_photo_text; " +
  "who/where/when/album/file name -> search_photo_metadata. All three take the same people, place, date and album filters, " +
  "given as plain names. Then use view_photo to see a result before describing it, and get_photo for its details and full text. " +
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
  const config = loadConfig();
  const library = new PhotoLibrary(new ImmichClient(config), {
    publicUrl: config.publicUrl,
    timeZone: config.timeZone,
  });

  const handle = await serve(() => createServer(library), { name: "immich-mcp" });

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
