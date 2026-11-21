# immich-mcp container image, built from this checkout:
#
#   docker build -t immich-mcp .
#
# Two stages: the first installs every dependency and compiles TypeScript, the
# second carries only the compiled server and its production dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-fund --no-audit

FROM node:22-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.title="immich-mcp" \
      org.opencontainers.image.description="MCP server for Immich photo retrieval: search by context, OCR text and metadata" \
      org.opencontainers.image.source="https://github.com/miguelarios/immich-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# An image is for running the server as a service, so it defaults to
# Streamable HTTP on port 3000. A stdio client overrides it:
# -e IMMICH_MCP_TRANSPORT=stdio.
ENV NODE_ENV=production \
    IMMICH_MCP_TRANSPORT=http \
    IMMICH_MCP_HTTP_HOST=0.0.0.0 \
    IMMICH_MCP_HTTP_PORT=3000

USER node
EXPOSE 3000

# /healthz answers without calling Immich. Over stdio there is no listener,
# so the check reports unhealthy, which `docker run --rm` ignores.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${IMMICH_MCP_HTTP_PORT}/healthz" || exit 1

ENTRYPOINT ["node", "/app/dist/bin/cli.js"]
