# Changelog

## 0.4.0 (2026-11-22)

The rest of Immich's search filters, and inputs grouped like its filter panel.

**Breaking:** the flat `city`, `state`, `country`, `takenFrom` and `takenTo` arguments are replaced
by `place {city, state, country}` and `taken {from, to}`. Clients read the schema on each
connection, so nothing needs migrating.

- New filters on every search: `minRating` / `unrated`, `camera {make, model, lens}`, `tags` (all
  must be on the photo) and `untagged`. Camera values and tags are given by name and resolved
  against what the library has.
- `search_photo_metadata` takes `path`: part of the folder or full path a file is stored under.
  `get_photo` reports a photo's path.
- New tools `list_tags` and `list_cameras`.
- Every tool refuses an argument it does not have, instead of ignoring it, and a malformed date is
  refused by the schema.
- Each search's description says when to use it and when to use a sibling instead.
- Sign-in creates keys with `tag.read` too. Existing connections keep working; to use the tag
  filters, reconnect and sign in again.

## 0.3.0 (2026-11-21)

Signing in no longer needs an API key made by hand.

- The sign-in page takes an Immich email and password. The server signs in to Immich once, creates
  a read-only key named `Immich MCP (<app> · <id>)`, signs out and drops the password. It is never
  stored, logged or put in a token.
- Signing in again from the same app replaces its key; no other app's key is ever removed.
- Five wrong passwords make an account wait 15 minutes on this page. Immich's own login is not
  affected.
- Pasting a key is still offered on the page, and `IMMICH_MCP_PASSWORD_SIGN_IN=false` removes the
  password form.
- The container image's build stage no longer runs under arm64 emulation, which hung the `0.2.0`
  release build.

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
