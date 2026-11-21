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

### For a household (sign-in)

With `IMMICH_MCP_AUTH=oauth` the server can face the internet: each person adds the URL to Claude
(or any MCP client that does OAuth), pastes a read-only Immich API key of their own on the sign-in
page, and from then on searches only what their Immich account can see.

```yaml
services:
  immich-mcp:
    image: ghcr.io/miguelarios/immich-mcp:0.2.0
    restart: unless-stopped
    environment:
      IMMICH_URL: http://immich-server:2283        # reached privately
      IMMICH_PUBLIC_URL: https://photos.example.com # for links and the sign-in page
      IMMICH_MCP_AUTH: oauth
      IMMICH_MCP_PUBLIC_URL: https://photos-mcp.example.com
      IMMICH_MCP_SECRET: ${IMMICH_MCP_SECRET:?openssl rand -base64 48}
      TZ: America/Chicago
```

Put it behind your TLS reverse proxy on **its own hostname** (OAuth discovery lives at the root of
the origin), and add `https://photos-mcp.example.com/mcp` as a connector. There is no volume: the
server stores nothing. See [Security](#security) for what that means.

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
| `IMMICH_API_KEY` | required, unless sign-in is on | See the permissions above |
| `IMMICH_PUBLIC_URL` | `IMMICH_URL` | Origin for links returned to the user, when the API is reached privately (`http://immich-server:2283`) |
| `TZ` | `UTC` | Zone bare dates are read in |
| `IMMICH_TIMEOUT_MS` | `30000` | Per-request timeout |
| `IMMICH_MCP_TRANSPORT` | `stdio` (`http` in the image) | |
| `IMMICH_MCP_HTTP_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | |
| `IMMICH_MCP_HTTP_PORT` | `3000` | |
| `IMMICH_MCP_HTTP_ALLOWED_ORIGINS` | none | Browser origins admitted; requests without `Origin` are always allowed |
| `IMMICH_MCP_AUTH` | `none` | `oauth` turns on sign-in (HTTP only); `IMMICH_API_KEY` must then be unset |
| `IMMICH_MCP_PUBLIC_URL` | required with `oauth` | The origin clients use, no path; https unless loopback |
| `IMMICH_MCP_SECRET` | required with `oauth` | 32+ characters; seals client ids and tokens. Changing it signs everyone out |
| `IMMICH_MCP_OAUTH_REDIRECT_URIS` | none | Extra redirect URIs to admit, comma-separated |

## Security

**Without sign-in (the default) the MCP endpoint does no authentication.** Anyone who can reach
the port can search and view your whole library with your API key. Bind it to loopback or a private
network. Browser requests from origins not in `IMMICH_MCP_HTTP_ALLOWED_ORIGINS` are refused, which
blocks DNS-rebinding attacks from web pages.

**With `IMMICH_MCP_AUTH=oauth`** the server is an OAuth 2.1 authorization server for itself
(discovery, dynamic client registration, PKCE S256, tokens bound to this server), and `/mcp`
answers only a valid token:

- **It never sees an Immich password.** People sign in to Immich as usual (password or passkey),
  create an API key there and paste it. A key that can do more than read is refused, as is one
  missing `asset.read`, `asset.view`, `person.read` or `album.read`.
- **Only known clients can connect.** Redirect URIs are limited to Claude's callbacks, loopback
  (desktop and CLI clients) and `IMMICH_MCP_OAUTH_REDIRECT_URIS`. Otherwise anyone could register
  a client and send a family member a link to the real sign-in page. Another hosted client is
  refused at registration with `invalid_redirect_uri` until its callback is added there.
- **Tell the family: only paste a key into a page you opened yourself**, from your own app, just
  now. A link to the sign-in page sent by someone else connects *their* app to your photos.
- **Nothing is stored.** A token is the person's API key sealed with `IMMICH_MCP_SECRET`
  (AES-256-GCM), valid for one hour and refreshed for up to 90 days at a time; after a year the
  key is pasted again. Keep the secret out of the repository and make it random
  (`openssl rand -base64 48`); whoever holds it and a token holds that read-only key.
- **To disconnect someone, delete their key in Immich.** There is no revocation here: the key
  stops working in Immich at once, and the client is asked to sign in again at the next refresh.
- **Run it behind a reverse proxy that sets `X-Forwarded-For`** and rate-limits `/authorize`,
  `/token` and `/register`. Key checks are budgeted per client address (10 a minute) and in total
  (60 a minute); without a proxy only the total applies.
- Each person's calls run with their own key, so Immich enforces what they can see, and album and
  place names are cached per key.

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
