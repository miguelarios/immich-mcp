# Changelog

## 0.1.0 (2026-11-21)

First release. A read-only MCP server for retrieving photos from Immich (v3.2+).

- `search_photos` — search by context: natural-language smart search (CLIP).
- `search_photo_text` — search by text in the image (OCR), with the matching lines per result.
- `search_photo_metadata` — search by file name, description, people, place, date and album.
- `get_photo` — one photo's details: time, place, camera, people, albums, tags and full OCR text.
- `view_photo` — the image itself (preview or thumbnail) as MCP image content.
- `list_people`, `list_albums` — discover the names the search filters accept.
- Every search accepts the same filters as plain names: people (all must appear, accent- and
  case-insensitive), album, city/state/country (resolved to Immich's stored spelling), date ranges
  read in the configured `TZ`, media type, favorites, archived.
- Streamable HTTP (`/mcp`, health at `/healthz`) and stdio; serves 2026-07-28 and 2025-era clients.
- Container image `ghcr.io/miguelarios/immich-mcp` for linux/amd64 and linux/arm64.
