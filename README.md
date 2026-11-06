# CLAWDE

A local-first, offline-capable AI assistant platform: chat, projects, memory, artifacts, agents, a model library
and a research and training studio. It runs on open-weight models and needs no paid APIs.

**Status:** Milestone 2 (interface foundation) complete. The web UI shell, navigation, themes and tests are done.
There is no backend yet: chat, projects and models start working from Milestones 3–5 onward (see the roadmap).

## Requirements

| Tool | Version used | Notes |
|---|---|---|
| Node.js | 22.x | |
| pnpm | 11.x | `corepack enable` or install from pnpm.io |
| Ollama | 0.32+ | Needed from Milestone 4 |
| Python + uv | 3.12 via uv | Needed from Milestone 3 |

## Run the web UI

```bash
pnpm install
```

```bash
pnpm dev:web
```

Open http://127.0.0.1:3000. The dev server binds to loopback only, and Next.js telemetry is disabled in the scripts.

## Checks

```bash
pnpm --filter desktop lint
```

```bash
pnpm --filter desktop typecheck
```

```bash
pnpm --filter desktop test
```

```bash
pnpm --filter desktop build
```

## Repository layout (so far)

```
apps/desktop/        Next.js 16 web UI (App Router, Tailwind v4, shadcn/ui on Radix)
  src/app/           Routes: / projects artifacts agents research models settings
  src/components/    shell/ (sidebar, command palette), page/, settings/, brand/, ui/ (shadcn)
  src/lib/           navigation config, preferences (theme/sidebar), shortcuts
docs/                Planning and architecture docs
```

## Docs

| Doc | Contents |
|---|---|
| [docs/01-assessment.md](docs/01-assessment.md) | Repository audit, hardware and toolchain report, measured model speeds |
| [docs/02-architecture.md](docs/02-architecture.md) | System architecture, module boundaries, model library/router, safety layers, data model |
| [docs/03-feature-matrix.md](docs/03-feature-matrix.md) | Every feature → milestone → feasibility → status |
| [docs/04-dependencies.md](docs/04-dependencies.md) | Dependencies and external runtimes |
| [docs/05-roadmap.md](docs/05-roadmap.md) | Milestones, acceptance tests, progress log, known limitations |
