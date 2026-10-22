# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NODE_OPTIONS=--max-old-space-size=4096
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @platform/api deploy --prod --legacy /out/api \
 && rm -rf /out/api/src /out/api/tests /out/api/tsconfig*.json /out/api/vitest.config.ts /out/api/dist \
 && cp -r apps/api/dist /out/api/dist

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
USER node
EXPOSE 4000 4100 4200
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://' + (process.env.API_HOST === '0.0.0.0' ? '127.0.0.1' : process.env.API_HOST) + ':' + (process.env.API_PORT || 4000) + '/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]

FROM caddy:2.11-alpine AS proxy
RUN apk upgrade --no-cache
COPY deploy/caddy/ /etc/caddy/
COPY --from=build /repo/apps/web/dist /srv/web

FROM postgres:17-alpine AS backup
RUN apk upgrade --no-cache && apk add --no-cache aws-cli && rm -f /usr/local/bin/gosu
COPY deploy/backup/ /usr/local/bin/
RUN chmod +x /usr/local/bin/*.sh
ENTRYPOINT []
CMD ["/usr/local/bin/backup-loop.sh"]
