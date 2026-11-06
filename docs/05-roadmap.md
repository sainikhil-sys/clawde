# CLAWDE — Development Roadmap & Checklist

Each milestone ends with: run the app → exercise the workflows → read the logs → fix → update docs and the
feature matrix. A milestone is checked off only when its acceptance tests pass.

One change to the original order: the **`ModelProvider` interface and a minimal registry move into M4**, so
chat is model-independent from day one. M11 then builds the full Model Library UI, the extra adapters and the router.

| # | Milestone | Deliverables | Acceptance (automated where marked 🧪) |
|---|---|---|---|
| 1 | Audit & hardware | `docs/01–05` | ✅ Done: repo empty, hardware measured, plan written |
| 2 | Frontend foundation | Next.js app, design tokens, light/dark, sidebar (8 sections), routing, responsive layout, keyboard nav, empty states | 🧪 lint + typecheck + component tests; every nav item routes to a real page |
| 3 | Backend & database | FastAPI skeleton, settings, structlog, SQLAlchemy models, Alembic, session/CSRF/Host checks, audit log, `/health` | 🧪 pytest: migrations up/down, auth, CSRF rejection, path-traversal tests |
| 4 | Inference & streaming | `ModelProvider`, Ollama adapter, minimal registry sync, SSE chat endpoint, stop via abort | 🧪 integration test against real Ollama (`llama3.2`), tokens stream, cancel works |
| 5 | Complete chat | Conversations CRUD, search (FTS5), folders, pin/archive, edit/regenerate branches, continue, retry, markdown/code, export, JSON mode, prompt templates | 🧪 persists across API restart; E2E Playwright happy path |
| 6 | Files & documents | Upload validation (size/type/magic), extraction for all listed types, previews, status + errors, chunking, embeddings, chat-with-file | 🧪 fixture files per type; malicious files rejected |
| 7 | Projects | Project CRUD, instructions, knowledge, scoped chats, per-project FAISS, search, export/delete | 🧪 isolation test: project A retrieval never returns B's chunks |
| 8 | Memory & retrieval | 5 memory kinds, CRUD/inspect UI, ranking, summarisation, context budgeting | 🧪 memory survives restart; deleted memory never retrieved |
| 9 | Artifacts | Sandbox origin server, iframe runtime, all artifact types, editor, versions, diff, fullscreen, export | 🧪 security tests: artifact cannot read parent cookies/DOM or call API |
| 10 | Agents & permissions | Tool registry, 8 tools, planner/executor, approvals UI, retry, cancel, history, Docker + fallback sandbox | 🧪 denied tool never runs; write outside workspace blocked; cancel mid-run |
| 11 | Model management | Model Library UI, llama.cpp + Transformers adapters, import/download/remove, metadata/licence/fit, behaviour profiles, router, RAM/GPU monitor, eval harness v1 (incl. refusal behaviour) | 🧪 switch models mid-conversation; router picks capable model that fits RAM |
| 12 | Research Studio | Datasets, tokenizer lab, tiny-transformer training, LoRA fine-tune on 0.5B model, logs (SSE), checkpoints, adapters, benchmarks, comparison | 🧪 a real (tiny) training run completes and is tracked; UI marks "training" vs "inference" clearly |
| 13 | Testing & optimisation | Full test pass, offline verification (network disabled), performance tuning, data export/delete-all, final docs (install, API via OpenAPI, schemas, limitations) | All acceptance criteria in the brief verified and recorded |

## Rough effort
M2–M5 make up the usable core (a local chat app with streaming and persistence). M6–M10 add the Claude-style
workflows. M11–M12 are the model-power-user layers. Every milestone is a working increment, never a mock.

## Known limitations (current)
- CPU-only inference: 7B models run at about 5 tok/s, so small models are the default for interactivity.
- Fine-tuning is limited to small base models; QLoRA and 7B training are out of scope without an NVIDIA GPU.
- The Python sandbox fallback without Docker is weaker isolation and is labelled as such.
- GPU telemetry for Intel iGPU is limited to utilisation counters.
