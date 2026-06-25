# syntax=docker/dockerfile:1

# Build stage: install all deps, build server + client, then prune dev deps.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.base.json tsconfig.json tsconfig.client.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage: copy the built app and production deps onto a clean base.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SELEYA_BIND_ADDRESS=0.0.0.0 \
    SELEYA_DB=/data/seleya.db
WORKDIR /app

# tini is PID 1 so signals are forwarded and the node process is reaped cleanly
# (Node should not run as PID 1). /data holds the SQLite cache, writable by the
# non-root node user and optionally backed by a mounted volume for persistence.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER node
EXPOSE 7920
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/server.js"]
