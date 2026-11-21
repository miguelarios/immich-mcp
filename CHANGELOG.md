# Changelog

## 0.2.0 (2026-11-21)

Sign-in, so one server can serve a household. Off by default; `0.1.0` setups run unchanged.

- `IMMICH_MCP_AUTH=oauth` makes the server its own OAuth 2.1 authorization server: discovery,
  dynamic client registration, PKCE, and tokens bound to this server. `/mcp` then answers only a
  valid token. Needs `IMMICH_MCP_PUBLIC_URL` and `IMMICH_MCP_SECRET`; `IMMICH_API_KEY` must be
  unset.
- Each person signs in by pasting a read-only Immich API key of their own. The server never sees
  an Immich password, so password and passkey accounts work alike, and Immich enforces what each
  person can see.
- Keys that can do more than read the photo library are refused.
- Only Claude's callbacks, loopback clients and `IMMICH_MCP_OAUTH_REDIRECT_URIS` can connect.
- Nothing is stored: tokens are the key sealed with the server secret. Delete the key in Immich to
  disconnect someone; a sign-in lasts at most a year.
- Album and place names are cached per key, never shared between people.

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
