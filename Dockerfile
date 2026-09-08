# syntax=docker/dockerfile:1.7
#
# Every production image, from one build.
#
#   docker build --target api     -t platform-api .      API, worker and migrations (same image)
#   docker build --target proxy   -t platform-proxy .    Caddy: HTTPS, and the built web app
#   docker build --target backup  -t platform-backup .   scheduled database backups
#
# Dependencies are installed inside the build, never copied from a laptop, so
# native modules (argon2, the Prisma engines) match the image's platform.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------------------
# Build: install everything, compile everything.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
# The editor bundle (Monaco) needs more than Node's default heap to build.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NODE_OPTIONS=--max-old-space-size=4096
# OpenSSL for Prisma's migration engine.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

# Manifests first, so the dependency layer is reused until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# A self-contained copy of the API with production dependencies only.
# Only what runs: compiled code, the schema and migrations, production
# dependencies. No sources, tests or compiler settings.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @platform/api deploy --prod --legacy /out/api \
 && rm -rf /out/api/src /out/api/tests /out/api/tsconfig*.json /out/api/vitest.config.ts /out/api/dist \
 && cp -r apps/api/dist /out/api/dist

# ---------------------------------------------------------------------------
# API and worker. `node dist/index.js` or `node dist/worker.js`.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
# OpenSSL for Prisma's migration engine: this image also applies migrations
# (`node_modules/.bin/prisma migrate deploy`).
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # The base image's package managers are not used at run time, and the npm it
 # bundles carried every known vulnerability an image scan found in this image.
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
# Unprivileged. The Docker socket is reached through a group granted at run
# time (see deploy/docker-compose.yml), never by running as root.
USER node
EXPOSE 4000 4100 4200
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://' + (process.env.API_HOST === '0.0.0.0' ? '127.0.0.1' : process.env.API_HOST) + ':' + (process.env.API_PORT || 4000) + '/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------------------
# Proxy: automatic HTTPS in front of everything, and the web app's files.
# ---------------------------------------------------------------------------
FROM caddy:2.11-alpine AS proxy
# Security fixes released since the base image was built.
RUN apk upgrade --no-cache
COPY deploy/caddy/ /etc/caddy/
COPY --from=build /repo/apps/web/dist /srv/web

# ---------------------------------------------------------------------------
# Backups: pg_dump on a schedule, kept locally and optionally copied to any
# S3-compatible bucket.
# ---------------------------------------------------------------------------
FROM postgres:17-alpine AS backup
# Security fixes since the base image; and gosu, which the server image uses to
# drop privileges and this one never runs, removed with its outdated Go runtime.
RUN apk upgrade --no-cache && apk add --no-cache aws-cli && rm -f /usr/local/bin/gosu
COPY deploy/backup/ /usr/local/bin/
RUN chmod +x /usr/local/bin/*.sh
ENTRYPOINT []
CMD ["/usr/local/bin/backup-loop.sh"]
