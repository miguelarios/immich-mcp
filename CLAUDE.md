# CLAUDE.md

## Project Overview

immich-mcp — a read-only MCP server for retrieving photos from Immich (v3.2+): search by context
(CLIP), by text in the image (OCR) and by metadata, then view the photo. Single package, shipped
as a container image (`ghcr.io/miguelarios/immich-mcp`); there is no npm release.

## Development Commands

- `npm test` — Vitest
- `npm run lint` / `npm run format` — Biome
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — emit `dist/` (tests excluded via `tsconfig.build.json`)

Run all four before pushing.

## Architecture

- `src/immich/` — `ImmichClient`, a typed `fetch` client over the slice of the REST API used, and
  the request/response types. Field names follow Immich's OpenAPI (`GET /api/spec.json` on any
  server). It maps HTTP failures to `ImmichMcpError` codes; note Immich answers **400, not 404**,
  for a missing asset.
- `src/library/PhotoLibrary.ts` — the workflows: resolves people/album/place names to what Immich
  filters on, turns dates into instants (`dates.ts`), runs the searches and shapes results into
  `PhotoSummary`. It caches the album and place lists for five minutes, so an instance must never
  serve two different API keys.
- `src/tools/` — the `ToolDef[]` (`index.ts`) and valibot output schemas (`schemas.ts`).
- `src/mcp/` — the MCP facade (`tools.ts`: `ToolDef`, `registerTools`, `structured`, `fail`) and the
  Streamable HTTP transport (`http.ts`), vendored from `@miguelarios/pim-core`
  (github.com/miguelarios/pim-agents) with the env vars renamed to `IMMICH_MCP_*`. Keep it in step
  with upstream rather than letting the two drift; the `auth` option is the one addition here.
- `src/auth/` — opt-in sign-in (`IMMICH_MCP_AUTH=oauth`): `oauth.ts` is the OAuth 2.1 authorization
  server (discovery, registration, the sign-in page, tokens) and the bearer check for `/mcp`;
  `immichLogin.ts` turns an email and password into a read-only key and signs out again;
  `seal.ts` encrypts client ids and tokens, so nothing is stored; `libraries.ts` keeps one
  `PhotoLibrary` per API key. The SDK only ships the resource-server half, hence the hand-written
  authorization server.
- `src/main.ts` — `createServer(library)` is a factory the HTTP transport calls per request
  (2026-07-28) or per session (2025-era): it must not open connections or install process handlers.
  `startServer` builds one shared library, or with sign-in on, a pool the factory picks from by
  the caller's key.

## Rules

- **Read-only.** No tool may change the library. A write tool would need its own design, the
  `confirmDestructive` gate from pim-core, and `destructiveHint` annotations.
- **Use Immich's v3.2 `filter` object**, never the deprecated flat search fields
  (`personIds`, `takenAfter`, `page`, `order`…). The two cannot be mixed in one request, and smart
  search has no pagination once `filter` is used.
- Filters take **names**, resolved server-side, and every search reports what they resolved to
  under `applied`. Unknown or ambiguous names fail with candidates rather than guessing.
- Inputs are hand-written JSON Schema (validated by the SDK before the handler runs); outputs are
  valibot schemas the SDK enforces. Every parameter and output field is camelCase (tested).
- **Sign-in stores nothing.** A password is used for one Immich login to create a read-only key
  (`immichLogin.ts`), then dropped: never stored, logged, echoed back or put in a token. Keys,
  created or pasted, must be read-only and travel only inside sealed tokens. Redirect URIs stay
  on an allowlist.
- Tool descriptions are written for a model choosing between tools: say when to use it and when to
  use a sibling instead.

## Code Style

- TypeScript strict, ES modules, Node >= 22.12
- Double quotes, 2-space indent, semicolons, 100 columns (Biome)
- Valibot, not Zod

## Testing

- `src/__tests__/fakeImmich.ts` is an in-process Immich behind a `fetch` function. Tests run the
  real client and library against it, so request bodies and query strings are asserted as sent.
- `roundtrip.test.ts` drives a real `@modelcontextprotocol/client` against the shipped
  `createServer` on both protocol eras in memory, and over real Streamable HTTP.
- `vitest.setup.ts` clears `IMMICH_*` from the environment so a developer's real key never
  reaches a test.
- **No personal data in fixtures, docs or examples**: placeholder people (Ada Lovelace, José
  Núñez), places and ids only.

## Filing issues and PRs

This repo inherits issue and PR templates from `miguelarios/.github`. They are
not in this checkout — resolve them through the API, never freehand the body.

Before filing, read the routing table:
https://github.com/miguelarios/.github/blob/main/CONTRIBUTING.md

Issues — pick the template by situation:

- `-T Bug` — wrong behavior. Requires expected vs actual, repro steps, logs,
  version, OS. Label `bug`.
- `-T Feature` — new capability. Requires a problem statement naming who is
  blocked, plus alternatives. Label `enhancement`.
- `-T Chore` — chore, refactor, bump, deploy. Requires acceptance criteria and
  rollback. Label `chore`.
- `-T Docs` — docs wrong or missing. Requires exact path, expected vs actual.
  Label `documentation`.

```bash
gh issue create -T Bug --title "fix: <symptom> when <trigger>" --label bug
```

PRs — always use the template and always link the issue:

```bash
gh pr create -T PULL_REQUEST_TEMPLATE.md --title "fix: <user-visible description>"
```

Alternate PR templates: `-T deploy.md` for container/image deploys,
`-T hotfix.md` for production incidents.

Rules that apply to every issue and PR here:

- Titles use Conventional Commit prefixes: `feat`, `fix`, `refactor`, `chore`,
  `docs`, `build`. Describe the user-visible effect, not the implementation.
- PRs carry a visible `Closes #<issue>` line.
- Every issue goes in a milestone (`--milestone "v<major>.<minor> <Theme>"`).
  Milestones are the roadmap; do not add a `ROADMAP.md`. File work as issues
  before building it.
- The verification section holds the real command and its real output. Never
  write "tested locally" or claim a passing test without pasting it. State
  explicitly what you could not verify.
- Redact tokens, API keys, and internal hostnames before pasting logs.

### In this repo

- PRs use the inherited default template (there is no local one). Fill the Release section with
  the version bump or "no release": merging a bump publishes the image (see Releasing).
- Merges are **squash merges**: the PR title becomes the commit subject on `main`, and the squash
  body is built from the branch's commit messages, so write those properly.
- Implementation plans stay out of the repo; design decisions go in `docs/design.md` in the same
  PR as the code.

## Releasing

**Merging a version bump is the release.** Bump `version` in `package.json`, add a matching
`## <version> (<date>)` section to `CHANGELOG.md`, and merge to `main` as
`chore(release): <version>`. `release.yml` tags `v<version>`, creates the GitHub Release from the
changelog section, then `docker.yml` builds and pushes `ghcr.io/miguelarios/immich-mcp:<version>`
for amd64 and arm64 (plus `<major>.<minor>`, `<major>` and `latest` for the newest stable).
If a step fails after the merge, re-run it with `gh workflow run release.yml`; an existing tag and
Release are skipped. To rebuild only an image, run **Container image** with the version.
