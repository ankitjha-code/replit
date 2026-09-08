# Local infrastructure

Everything the platform depends on, running locally in Docker. The API and web
client are **not** here: they run on the host via `pnpm dev`, so the
edit-reload loop stays fast. The proxy reaches them through the host gateway.

## Commands

Run from the repository root.

| Command | What it does |
| --- | --- |
| `pnpm infra:up` | Starts everything and waits for healthy |
| `pnpm infra:down` | Stops and removes containers. **Data is kept.** |
| `pnpm infra:reset` | Stops and **destroys all data**. Volumes are deleted. |
| `pnpm infra:ps` | Shows service status |
| `pnpm infra:logs` | Tails logs from every service |
| `pnpm infra:config` | Prints the fully resolved Compose configuration |

`pnpm infra:up` creates `.env` from `.env.example` if it is missing.

## Services

| Service | Port | Purpose |
| --- | --- | --- |
| `postgres` | 5442 | Platform database: users, projects, permissions, metadata |
| `minio` | 9100 (API), 9101 (console) | Object storage for project assets |
| `proxy` | 8080 | Single public origin; preview and deployment routing |
| `redis` | 6389 | **Not started.** See below. |

Every port binds to `127.0.0.1` only. None of these is reachable from another
machine on the network.

Ports avoid the conventional 5432, 6379 and 9000 so an unrelated local stack
keeps working alongside this one.

### The platform database is not the user's database

`postgres` here holds platform state only. The database a user's application
receives is provisioned separately, with its own lifecycle. Mixing them would
let a user's application read every other project's data.

### Redis is deliberately not running

Nothing in the platform needs a queue, pub/sub or cross-process presence yet.
Running Redis now would mean keeping infrastructure alive for no reason.

It is defined and verified working, so the day a workload justifies it (build
jobs, cross-process presence) it is one flag away:

```bash
docker compose --env-file .env -f infra/docker-compose.yml --profile queue up -d
```

Then set `REDIS_URL` in `.env`. Until that variable is set, the platform does
not register a Redis health probe at all, so readiness stays truthful rather
than reporting a permanently failing dependency nobody is running.

## Reverse proxy

One origin, three kinds of traffic separated by Host header:

```text
localhost:8080              platform  ->  /api /health /ws  -> control plane
                                          everything else   -> web client
*.preview.localhost:8080    project development preview     (Task 20)
*.app.localhost:8080        running deployment              (Task 39)
```

Browsers resolve any `*.localhost` name to the loopback address, so preview and
deployment hostnames work locally with no DNS setup and no hosts-file editing.

Preview and deployment hosts are matched today and answer that no route exists.
They are not wired to any runtime and nothing pretends otherwise. Task 20
replaces the fixed response with an upstream resolved per project.

## Storage

`minio-init` creates the asset bucket on every `up` and denies anonymous
access to it. It is idempotent, so repeated runs are a no-op.

Assets are always served through the platform, which checks project
permissions first. The bucket must never be publicly readable.

## Data persistence

All state lives in named Docker volumes, never bind mounts:

```text
platform_postgres_data    platform_minio_data    platform_redis_data
platform_caddy_data       platform_caddy_config
```

`pnpm infra:down` removes containers and keeps volumes. This was verified by
writing rows to Postgres and an object to MinIO, destroying every container,
recreating them, and reading both back intact.

Only `pnpm infra:reset` destroys data.

## Credentials

The defaults in `docker-compose.yml` and `.env.example` are development
credentials, deliberately obvious (`platform_dev_only`). They are usable only
from loopback on your own machine.

Override them in `.env`, which is never committed, before running anywhere
else.
