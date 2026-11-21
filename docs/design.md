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
