# CLAWDE

A local-first, offline-capable AI assistant platform: chat, projects, memory, artifacts, agents, a model library
and a research and training studio. It runs on open-weight models and needs no paid APIs.

**Status:** Milestones 1–10 done; model management arrives in Milestone 11. What works today:
- Chat with any model installed in Ollama: Markdown and highlighted code, editing, regenerating, continuing and
  retrying (with version history), stop, search, folders, pin/archive, export, prompt templates and JSON mode.
- File attachments (PDF, Word, Excel, CSV, JSON, Markdown, text, source code, images) that the model reads.
- Projects with shared instructions and knowledge files, each with its own isolated search index.
- Persistent memory you can inspect, edit and delete (preferences, conversation summaries, project notes,
  knowledge, temporary context).
- Artifacts (web pages, React components, SVG, Markdown, Mermaid diagrams, charts, JavaScript, code) with live
  preview in an isolated sandbox, a source editor, version history, comparison, full screen and export.
- Agents that plan and use tools (workspace files, document/knowledge/project search, calculator, JSON,
  sandboxed Python), with per-tool permissions, approval before writing files or running code, cancel, retry
  and full step history.

## Requirements

| Tool | Version used | Notes |
|---|---|---|
| Node.js | 22.x | |
| pnpm | 11.x | `corepack enable` or install from pnpm.io |
| uv | 0.11+ | Installs Python 3.12 and the API's dependencies |
| Ollama | 0.32+ | Runs the models. Install at least one chat model, e.g. `ollama pull llama3.2` |

## First-time setup

```bash
pnpm install
```

```bash
uv sync
```

## Run

Start the API, the web UI and the artifact sandbox in three terminals:

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

```bash
pnpm dev:sandbox
```

The sandbox (port 3901) serves the page that artifact previews run in. It is a separate origin with no network
access, so artifact code never runs inside the app. Without it, chat works but previews show a notice.

Make sure the Ollama app is running, then open http://127.0.0.1:3000. Both servers bind to loopback only. The API stores its data in
`%LOCALAPPDATA%\Clawde` (database and logs). Change this with `CLAWDE_DATA_DIR`; see [docs/api.md](docs/api.md).

## Checks

Run everything (API lint, types and tests, web lint, types and tests, then the sandbox server tests):

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

The API test suite includes two live tests against the real Ollama server (using the smallest installed chat
model). They are skipped automatically when Ollama isn't running; run only them with `uv run pytest -m live`.

```bash
pnpm build:web
```

End-to-end tests drive the real stack (production web build, API with a temporary data folder,
local Ollama) in the Microsoft Edge already installed on Windows. No browser download is needed:

```bash
pnpm --filter desktop e2e
```

## Repository layout (so far)

```
apps/desktop/        Next.js 16 web UI (App Router, Tailwind v4, shadcn/ui on Radix)
apps/sandbox/        Artifact runtime + static server (separate origin, strict CSP, vendored libraries)
apps/api/            FastAPI app: config, middleware, security (sessions/CSRF), routers, SSE streaming, CLI
core/inference/      Provider-independent ModelProvider protocol, gateway, types
core/orchestrator/   One chat turn: stream, forward, persist (incl. stop/cancel)
core/context/        Fitting history into the model's context window
core/memory/         Memory ranking policy and how memory is shown to the model
core/artifacts/      Finding artifact blocks in replies; instructions for models
core/tools/          Agent tools (typed arguments, risk levels) and the registry
core/permissions/    Tool permission policies (write/execute can never run without approval)
core/agents/         Agent prompts and response parsing
models/adapters/     Ollama adapter (llama.cpp and Transformers adapters come in M11)
models/registry/     Model registry synced from providers
services/            audit/, settings/, conversation/: business logic used by the API
storage/database/    SQLAlchemy models, async engine, Alembic migrations
storage/local_files/ Path-traversal-safe file access (safe_join)
services/document_processing/  File type validation, text extraction, chunking
services/retrieval/  Passage ranking (BM25, optional embeddings)
services/attachments/ Upload storage, background processing, model context
services/projects/   Project listing, search, export, deletion
services/memory/     Memory storage, scope rules, recall for chat turns, summaries
services/artifacts/  Artifact storage, versions, restore, extraction from replies
services/agents/     Agent runs: plan, tool loop, approvals, cancellation, events
services/sandbox/    Python sandbox (Docker container, or a limited local process)
storage/vector_index/ Per-scope FAISS indexes (one per project)
tests/backend/       API, database and migration tests
tests/security/      Path safety tests
tests/integration/   Live tests against a running Ollama
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
