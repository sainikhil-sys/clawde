# CLAWDE

A local-first, offline-capable AI assistant platform: chat, projects, memory, artifacts, agents, a model library
and a research and training studio. It runs on open-weight models and needs no paid APIs.

**Status:** Milestone 3 (local API and database) complete. The web UI talks to a FastAPI backend with a SQLite
database, browser sessions, CSRF protection and an audit log. Chat with local models arrives in Milestone 4.

## Requirements

| Tool | Version used | Notes |
|---|---|---|
| Node.js | 22.x | |
| pnpm | 11.x | `corepack enable` or install from pnpm.io |
| uv | 0.11+ | Installs Python 3.12 and the API's dependencies |
| Ollama | 0.32+ | Needed from Milestone 4 |

## First-time setup

```bash
pnpm install
```

```bash
uv sync
```

## Run

Start the API and the web UI in two terminals:

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

Open http://127.0.0.1:3000. Both servers bind to loopback only. The API stores its data in
`%LOCALAPPDATA%\Clawde` (database and logs). Change this with `CLAWDE_DATA_DIR`; see [docs/api.md](docs/api.md).

## Checks

Run everything (API lint, types and tests, then web lint, types and tests):

```bash
pnpm check
```

Or individually:

```bash
pnpm test:api
```

```bash
pnpm test:web
```

```bash
pnpm build:web
```

## Repository layout (so far)

```
apps/desktop/        Next.js 16 web UI (App Router, Tailwind v4, shadcn/ui on Radix)
apps/api/            FastAPI app: config, middleware, security (sessions/CSRF), routers, CLI
services/            audit/, settings/: business logic used by the API
storage/database/    SQLAlchemy models, async engine, Alembic migrations
storage/local_files/ Path-traversal-safe file access (safe_join)
tests/backend/       API, database and migration tests
tests/security/      Path safety tests
docs/                Planning, architecture, API and schema docs
```

## Docs

| Doc | Contents |
|---|---|
| [docs/01-assessment.md](docs/01-assessment.md) | Repository audit, hardware and toolchain report, measured model speeds |
| [docs/02-architecture.md](docs/02-architecture.md) | System architecture, module boundaries, model library/router, safety layers, data model |
| [docs/03-feature-matrix.md](docs/03-feature-matrix.md) | Every feature → milestone → feasibility → status |
| [docs/04-dependencies.md](docs/04-dependencies.md) | Dependencies and external runtimes |
| [docs/05-roadmap.md](docs/05-roadmap.md) | Milestones, acceptance tests, progress log, known limitations |
| [docs/api.md](docs/api.md) | API endpoints, security conventions, CLI, configuration |
| [docs/database.md](docs/database.md) | Database schema and migration notes |
