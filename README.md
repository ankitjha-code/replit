# Workspace

A browser-based development platform. You create a project, write code in the browser, run it in its own container, open a terminal into it, see a live preview, and deploy it to a public URL.

Live demo: <https://ankitcloud.me>

## Features

- Monaco editor with tabs, autosave and real-time collaborative editing (Yjs)
- Starter templates for Node.js, Python, Go, Ruby and static sites
- Each project runs in its own Docker container with CPU, memory and process limits, no extra privileges, and a network of its own
- Run button with streamed output, plus interactive shells (xterm.js) inside the container
- Live preview on a per-project subdomain
- One-click deployments to `<name>.app.<your-domain>`, with custom domain support
- Environment variables, encrypted secrets and a PostgreSQL database per project
- File uploads to S3-compatible storage
- Snapshots and git history, with restore
- Sharing with owner, editor and viewer roles
- Monitoring, logs and alerts per project
- Operator console for accounts, hosts, limits and cleanup

## Stack

| Part | Built with |
| --- | --- |
| Web client | React 19, Vite, Monaco, xterm.js, Yjs |
| API and worker | Node.js, Express 5, Prisma 7, Zod, WebSockets |
| Data | PostgreSQL (platform and project databases), Redis, MinIO |
| Runtimes | Docker, optionally gVisor |
| Proxy and TLS | Caddy with automatic Let's Encrypt certificates |
| Tests | Vitest, Supertest, Playwright |

## Project layout

```text
apps/api         API, background worker and container orchestration
apps/web         React client
packages/shared  Types and schemas shared by the API and the client
e2e              Playwright end-to-end tests
infra            Docker Compose setup for local development
deploy           Production Compose file, Caddy config, backups, monitoring
scripts          Smoke tests and helper scripts
```

## Running locally

You need Node.js 24, pnpm 9 or newer, and Docker with Compose.

```bash
pnpm install
pnpm infra:up      # starts PostgreSQL, MinIO and Caddy (creates .env on first run)
pnpm db:deploy     # applies database migrations
pnpm build         # builds the shared package once
pnpm dev           # runs the API and the web client
```

Then open <http://localhost:8080>.

To run projects in containers, set `EXECUTION_PROVIDER=docker` in `.env`. To enable deployments, set `DEPLOYMENT_PROVIDER` as well. Every setting is listed in `.env.example`.

Useful commands:

| Command | What it does |
| --- | --- |
| `pnpm dev:worker` | Runs the background worker as a separate process |
| `pnpm infra:down` | Stops the local services and keeps their data |
| `pnpm infra:reset` | Stops the local services and deletes their data |
| `pnpm db:migrate` | Creates a migration from schema changes |
| `pnpm db:studio` | Opens Prisma Studio |

## Tests

```bash
pnpm check       # formatting, lint, typecheck, unit and integration tests
pnpm test:e2e    # builds the app and runs the Playwright suite
```

Integration tests need the local services from `pnpm infra:up`. Before the first e2e run, install the browser with `pnpm --filter @platform/e2e install-browsers`.

Use Node 24 for the web tests. Node 25 and newer define a global `localStorage` that replaces the one jsdom provides.

## Deploying

Production runs on a single Linux server with Docker. It needs ports 80 and 443 open, and a domain with two DNS records pointing at the server: `@` and `*`.

```bash
cp deploy/production.env.example deploy/production.env   # fill in domain, secrets and SMTP
docker compose --env-file deploy/production.env -f deploy/docker-compose.yml up -d --build
```

Caddy gets certificates from Let's Encrypt on first request. After you register an account, make it an operator:

```bash
docker compose --env-file deploy/production.env -f deploy/docker-compose.yml \
  exec api node dist/scripts/grant-operator.js you@example.com
```

`scripts/production-smoke.mjs` checks a live installation end to end: sign-up, running code, preview, deployment and a backup restore.
