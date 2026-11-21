# immich-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent find and look at photos in
your [Immich](https://immich.app) library — the same three searches as the Immich app, shaped as
workflows rather than raw endpoints:

| Tool | Search by | Example |
| --- | --- | --- |
| `search_photos` | **context** — what the photo shows (CLIP smart search) | "sunrise on the beach" |
| `search_photo_text` | **text in the image** (OCR) | "check out receipt", "wifi password" |
| `search_photo_metadata` | file name, description, people, place, date, album | "videos of Ada in Mexico, 2024" |
| `get_photo` | one photo's details and full OCR text | |
| `view_photo` | the image itself, returned as MCP image content | |
| `list_people` / `list_albums` | the names the filters accept | |

It is **read-only**: no tool uploads, edits, moves or deletes anything, and every tool is annotated
`readOnlyHint`.

## Why it is more than an API wrapper

- **Filters take plain names.** `people: ["jose"]` finds "José Núñez"; `city: "zurich"` is
  resolved to the "Zürich" Immich stored (its place filter is exact and case-sensitive); an album
  can be given by name. Ambiguous or unknown names fail with the candidates, so the model can
  correct itself. Each result reports what the names resolved to under `applied`.
- **Dates are calendar periods in your zone.** `takenFrom: "2024-06", takenTo: "2024-06"` is all of
  June 2024 as lived in `TZ`, DST included. Timestamps keep their offset.
- **OCR results say why they matched**: each hit carries the matching lines of text.
- **Compact results**: about ten fields per photo instead of Immich's ~40, plus a link to open it
  in Immich. Live Photo video halves, hidden and locked items are excluded; archived on request.
- **The model can see the photo** (`view_photo`), to check a match before describing it.

## Requirements

- Immich **v3.2 or newer** (it uses the `filter` search API introduced in 3.2; tested on 3.4.2),
  with Smart Search and OCR enabled for the context and text searches.
- An API key (Account Settings → API Keys) with at least `asset.read`, `asset.view`,
  `person.read` and `album.read`.

## Run it

### Docker (Streamable HTTP)

```bash
docker run -d --name immich-mcp -p 127.0.0.1:3000:3000 \
  -e IMMICH_URL=https://photos.example.com \
  -e IMMICH_API_KEY=... \
  -e TZ=America/Chicago \
  ghcr.io/miguelarios/immich-mcp:0.1.0
curl -s http://127.0.0.1:3000/healthz   # ok
```

The endpoint is `http://127.0.0.1:3000/mcp`. Compose:

```yaml
services:
  immich-mcp:
    image: ghcr.io/miguelarios/immich-mcp:0.1.0
    restart: unless-stopped
    environment:
      IMMICH_URL: https://photos.example.com
      IMMICH_API_KEY: ${IMMICH_API_KEY:?set in .env}
      TZ: America/Chicago
    ports:
      - "127.0.0.1:3000:3000"
```

### From source (stdio or HTTP)

```bash
npm ci && npm run build
IMMICH_URL=... IMMICH_API_KEY=... node dist/bin/cli.js                              # stdio
IMMICH_MCP_TRANSPORT=http IMMICH_URL=... IMMICH_API_KEY=... node dist/bin/cli.js    # HTTP :3000
```

### Connect a client

```bash
claude mcp add --transport http immich http://127.0.0.1:3000/mcp
hermes mcp add immich --url http://127.0.0.1:3000/mcp
```

Other clients: `{"type": "http", "url": "http://127.0.0.1:3000/mcp"}`.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `IMMICH_URL` | required | Server origin; a trailing `/api` is accepted |
| `IMMICH_API_KEY` | required | See the permissions above |
| `IMMICH_PUBLIC_URL` | `IMMICH_URL` | Origin for links returned to the user, when the API is reached privately (`http://immich-server:2283`) |
| `TZ` | `UTC` | Zone bare dates are read in |
| `IMMICH_TIMEOUT_MS` | `30000` | Per-request timeout |
| `IMMICH_MCP_TRANSPORT` | `stdio` (`http` in the image) | |
| `IMMICH_MCP_HTTP_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | |
| `IMMICH_MCP_HTTP_PORT` | `3000` | |
| `IMMICH_MCP_HTTP_ALLOWED_ORIGINS` | none | Browser origins admitted; requests without `Origin` are always allowed |

## Security

**The MCP endpoint does no authentication.** Anyone who can reach the port can search and view
your whole library with your API key. Bind it to loopback (as above) or a private network, and
put an OAuth proxy in front before exposing it anywhere else. Browser requests from origins not in
`IMMICH_MCP_HTTP_ALLOWED_ORIGINS` are refused, which blocks DNS-rebinding attacks from web pages.

## Protocol

Streamable HTTP at `/mcp` (health at `/healthz`), or stdio. Clients on protocol revision
2026-07-28 are served statelessly, one request at a time; 2025-era clients get a session
(`Mcp-Session-Id`, closed after 30 minutes idle).

## Development

```bash
npm ci
npm test && npm run lint && npm run typecheck && npm run build
```

See [CLAUDE.md](CLAUDE.md) for the architecture and conventions, and
[docs/design.md](docs/design.md) for the decisions behind the tool set.

## License

MIT
