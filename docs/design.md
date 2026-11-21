# Design: immich-mcp 0.1

## Goal

Let an agent answer "find that photo" requests against an Immich library the way a person uses the
app's search modes: by **context** (what it shows), by **text in the image** (OCR), and by
**metadata** (file name, description, who, where, when). Retrieval only.

## Tool set

Seven tools, chosen around workflows rather than endpoints:

1. `search_photos` → `POST /search/smart`
2. `search_photo_text` → `POST /search/metadata` with `filter.ocr`, then `GET /assets/{id}/ocr`
   per hit (concurrency 8) to attach the lines that matched
3. `search_photo_metadata` → `POST /search/metadata` with name/description patterns
4. `get_photo` → `GET /assets/{id}` + `GET /albums?assetId=` + `GET /assets/{id}/ocr`
5. `view_photo` → `GET /assets/{id}/thumbnail?size=preview|thumbnail`, returned as image content
6. `list_people` → `GET /search/person` or `GET /people`
7. `list_albums` → `GET /albums`

The Immich app has separate "file name" and "description" modes; here both are parameters of the
metadata search, because a model looking for "IMG_1234 from Cancún" wants them combined with the
other filters in one call.

### Rejected

- **One `search` tool with a `mode` parameter.** Models pick tools by description; three tools with
  "use this when…, use the sibling for…" descriptions route better than a mode enum, and each can
  have the pagination its endpoint actually supports.
- **Exposing every endpoint** (timeline buckets, map markers, memories, stacks, faces). Each one is
  a call the model has to learn to chain; none serves retrieval that the three searches don't.
  Add one only when a real request needs it.
- **Write tools** (favorite, tag, add to album). Out of scope for retrieval; they need confirmation
  design first.
- **Depending on `@miguelarios/pim-core`** for the transport. Its `/mcp` subpath is the right code,
  but the package is PIM-namespaced (`PIM_MCP_*` env, `PimError` codes) and pulls ical/timezone
  dependencies. Vendored instead, with a pointer back to upstream.

## Decisions

- **The v3.2 `filter` API only.** Immich 3.2 deprecated the flat search fields for a typed
  `filter` object and cursor pagination. Mixing them is a validation error ("Deprecated field page
  cannot be combined with filter"), so smart search returns a single ranked page (limit up to 200)
  and the metadata searches page by `nextCursor`.
- **Names, not ids, as filter input.** People resolve via `/search/person` (accent-insensitive on
  the server); an exact folded full-name match wins, then a unique first-name match, then a sole
  candidate; anything else fails with the candidates. Places resolve against
  `/search/suggestions`, because Immich's place filter is exact and case-sensitive ("cancun" finds
  nothing when it stored "Cancún"). Every search returns `applied` so the model can see, and tell
  the user, what it actually searched for.
- **Dates are calendar periods in `TZ`, both ends inclusive.** `takenTo: "2024"` means through the
  last instant of 2024 locally (`lt` the next period's start). The `takenAt` filter compares UTC
  instants, so the zone conversion happens here, DST-correct.
- **Default visibility is the timeline.** Without a visibility filter Immich also returns the hidden
  video halves of Live Photos, which look like a duplicate video of every match. Archived items are
  opt-in; locked items are never searched.
- **Compact summaries.** `localDateTime` is wall-clock time serialized with a misleading `Z`; it is
  returned as `takenAt` without a zone. Unnamed face clusters (empty names) are dropped from
  `people` everywhere.
- **Images are capped at 5 MB** and default to the ~1440 px preview, which is enough to read a sign
  and costs far less context than the original.

## Measured against a 3.4.2 server

Smart search ~0.2-0.6 s warm (first call after idle ~6 s while the CLIP model loads), OCR search
~0.2 s, metadata search ~0.05 s, OCR lines per asset ~0.04 s, preview ~0.3 MB.

# Design: sign-in for a household (0.2)

## Goal

Run one server next to Immich for the whole family. Each person adds the URL to their MCP client,
signs in once, and their agent sees what their own Immich account sees.

## The constraint

Immich's API accepts an API key or its own session token, never an OAuth token, and Immich is an
OIDC client, not a provider. So OAuth can only answer "who is calling"; an Immich API key per
person still has to answer "what may they see". The server is therefore its own OAuth 2.1
authorization server, and signing in means giving it a key.

## Decisions

- **Paste a key; no password form.** The page at `/authorize` asks for an Immich API key the person
  created themselves. The server never handles an Immich password, it works the same for password
  and passkey accounts, and it will keep working when Immich logins move to an identity provider.
  The cost is a few clicks in Immich's settings, once per person.
- **Read-only keys only.** A key is accepted when Immich reports the four permissions the tools
  need and nothing outside a short list of photo-library reads (statistics, faces, map, memories,
  stacks, tags, timeline). A full-access key is refused, and so is one that can read sessions,
  API keys or shared links, so the worst a leaked token can do is read photos.
- **Stateless: sealed tokens, no database.** A client id is its registration, and a token is the
  API key plus an expiry, each sealed with AES-256-GCM under a key derived per purpose from
  `IMMICH_MCP_SECRET`. No volume, nothing to back up, and open registration cannot fill a table.
  Only authorization codes live in memory (60 seconds, single use). The trade: no revocation
  list and no refresh-token reuse detection. Deleting the key in Immich is the revocation; the
  refresh, hourly, asks Immich whether the key still stands and ends the session when it does not.
  An unreachable Immich is not treated as a verdict. Photo calls stop at once, since Immich
  rejects the key; only names cached in the last five minutes outlive it. A sign-in also ends
  after a year whatever happens, so a stolen refresh token cannot be renewed forever.
- **The secret is as sensitive as every key.** Whoever has `IMMICH_MCP_SECRET` and a token can
  open the token. Anyone with a token can also test guesses of the secret offline, so startup
  refuses a short or repetitive one.
- **Redirect URIs on an allowlist.** Registration is open (clients register themselves), but only
  for Claude's callbacks, loopback, and configured extras. With arbitrary redirects, anyone could
  register a client and send a family member a link to the genuine sign-in page, then collect the
  code. The page shows where it returns, and the client's name only as what the app calls itself,
  since anyone can register any name.
- **What the allowlist cannot stop.** Someone can start connecting in their own Claude account
  and send the resulting link to a family member; the page is genuine and returns to Claude. The
  client's `state` check is the defence against that, and it is the client's, not ours. The page
  therefore says to continue only if you started this yourself, just now.
- **Key checks are budgeted per address and in total.** Each one calls Immich. Behind the reverse
  proxy the caller's address is the last `X-Forwarded-For` entry, so one address cannot use up
  the budget for everyone; text that is not key-shaped is refused without a call. The reverse
  proxy should rate-limit `/authorize`, `/token` and `/register` as well.
- **One library per key.** `PhotoLibrary` caches album and place names; shared between callers it
  would resolve one person's album names for another. `LibraryPool` keys libraries by a hash of
  the API key, and a 2025-era session answers only the caller that opened it.
- **Its own hostname, no path.** Discovery documents live at the origin's root; under a path on
  Immich's hostname they would need routes carved out of Immich's own URL space.
- **Hand-written authorization server.** `@modelcontextprotocol/server` 2.x ships the
  resource-server half (`requireBearerAuth`, used here) but no authorization server. The routes
  are small because nothing is stored.

### Rejected

- **Immich email and password form.** A second place where the family types their Immich
  password, a password-guessing surface that Immich cannot rate-limit per client (every attempt
  comes from this server), and no way in for passkey-only accounts.
- **SQLite for clients, codes and tokens.** Needed only for revocation, which Immich already has.
- **An identity provider in front of `/mcp`** (forward auth). MCP clients call from their own
  servers and cannot complete an interactive login per request.

## Later

A second factor: Immich passkeys already cover signing in to Immich itself, which is the only
login in this flow. An identity provider would slot in as a step before the paste page.
