# CLAWDE — Development Roadmap & Checklist

Each milestone ends with: run the app → exercise the workflows → read the logs → fix → update docs and the
feature matrix. A milestone is checked off only when its acceptance tests pass.

One change to the original order: the **`ModelProvider` interface and a minimal registry move into M4**, so
chat is model-independent from day one. M11 then builds the full Model Library UI, the extra adapters and the router.

| # | Milestone | Deliverables | Acceptance (automated where marked 🧪) |
|---|---|---|---|
| 1 | Audit & hardware | `docs/01–05` | ✅ Done: repo empty, hardware measured, plan written |
| 2 | Frontend foundation | Next.js app, design tokens, light/dark, sidebar (8 sections), routing, responsive layout, keyboard nav, empty states | ✅ Done: see progress log |
| 3 | Backend & database | FastAPI skeleton, settings, structlog, SQLAlchemy models, Alembic, session/CSRF/Host checks, audit log, `/health` | ✅ Done: see progress log |
| 4 | Inference & streaming | `ModelProvider`, Ollama adapter, minimal registry sync, SSE chat endpoint, stop via abort | ✅ Done: see progress log |
| 5 | Complete chat | Conversations CRUD, search, folders, pin/archive, edit/regenerate branches, continue, retry, markdown/code, export, JSON mode, prompt templates | ✅ Done: see progress log |
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

## Progress log

### Milestone 2: interface foundation (2026-11-06)
Built:
- `apps/desktop`: Next.js 16.4 (App Router, Cache Components), React 19.3, Tailwind 4, shadcn/ui (Radix), Motion, Lucide.
- Design tokens: warm neutrals with one verdigris accent, in light and dark. Newsreader for headings, Geist for
  UI and code. All fonts are bundled from npm, so no network is needed at build or run time.
- Shell: collapsible sidebar (state persists and is applied before first paint, so no flash), mobile drawer,
  skip link, `Ctrl+K` command palette (sections plus theme and sidebar commands), `Ctrl+.` sidebar toggle.
- Routes for all 8 sections. Sections without a backend show an empty state that names the milestone that
  delivers them, and contain no dead buttons. Settings: working theme picker, shortcuts list, privacy facts.
- Baseline security headers. Next.js telemetry is disabled, and the dev server binds to `127.0.0.1`.

Verified:
- 21 unit/component tests passing (navigation config, every nav route has a page file, preference store and boot
  script, sidebar active state, collapse, palette search → navigation, theme switching, mobile drawer).
- `eslint`, `tsc`, `prettier --check` and `next build` all clean; all routes prerender statically.
- Manual run in a browser: every nav link reaches the right page and title, theme and sidebar survive a reload,
  mobile drawer navigates and closes, no horizontal scroll at 375px, no console errors. All resource requests
  went to `127.0.0.1:3000` only.

Deferred:
- Playwright E2E tests move to Milestone 5, once there are real chat workflows to cover.
- Full Content-Security-Policy is scheduled for Milestone 9 (needs a nonce for the inline preference script).

### Milestone 3: local API and database (2026-11-06)
Built:
- `apps/api`: FastAPI 0.162 app factory with lifespan, `clawde-api` CLI (`serve`, `migrate`, `downgrade`,
  `info`), and typed `CLAWDE_*` config. The API refuses to bind to non-loopback hosts unless explicitly allowed.
- Storage: SQLAlchemy 2.1 async with SQLite (WAL, foreign keys on) and an Alembic `0001_initial` migration
  applied at startup. Tables: `app_sessions`, `audit_events`, `settings`, `folders`, `projects`,
  `conversations`, `messages`.
- Security: Host allowlist (blocks DNS rebinding), CORS and Origin allowlist, `HttpOnly; SameSite=Strict`
  session cookie storing only a hash, CSRF header on mutations, 1 MiB body limit, security headers, request IDs.
- Services: append-only audit log (refuses secret-looking keys), typed settings with change diffs.
- `storage/local_files.safe_join`: blocks traversal, absolute/drive/UNC paths, reserved device names, ADS,
  trailing-dot aliasing, and escapes through symlinks or junctions.
- Logging: structlog with console output and rotating JSON lines in `<data_dir>/logs/api.log`.
- Web UI: API client with automatic session and CSRF handling and expiry recovery, React Query, live API status
  (home and Settings), and an Activity log in Settings with loading, empty, error and pagination states.

Verified:
- 61 backend tests: migrations up/down/up, model–migration drift, FK cascade, cookie flags, token hashing,
  Origin, Host, CSRF and CORS rejection, expiry, logout replay, body limit, restart persistence, audit
  without secrets, 31 path-traversal cases including a junction escape.
- 30 frontend tests (9 new: API client session/CSRF/retry/errors, status panel states).
- `ruff`, `mypy --strict`, `eslint`, `tsc` all clean.
- Manual end-to-end run in the browser: session created over CORS, cookie not readable by page scripts,
  PATCH without CSRF → 403 with no change, reload reuses the session, stopping the API shows "not running"
  with instructions, and after restart the earlier activity and session are still there.

Notes:
- The first page load logs one expected 401 in the browser console (checking for a session before creating one).
- Other local processes running as the same OS user are inside the trust boundary (documented in
  `apps/api/security.py`).

### Milestone 4: local model inference and streaming (2026-11-06)
Built:
- `core/inference`: `ModelProvider` protocol, `InferenceGateway` (model ids are `<provider>:<ref>`), typed
  `GenerationParams` (temperature, top-p, max tokens, context window, seed).
- `models/adapters/ollama.py`: model listing with metadata (family, size, quantization, context length,
  capabilities) from `/api/tags`, NDJSON chat streaming, error mapping, and abort on close. Local only, never
  through a system proxy.
- `models/registry`: `models` table (migration `0002`), synced on every model list. Removed models are kept but
  marked unavailable; there are no hardcoded model names.
- `core/orchestrator/chat_turn.py`: streams a turn as SSE events (`start`, `token`, `done`, `error`) and
  persists the outcome: complete, error (partial text kept) or cancelled (partial text kept).
- `apps/api/streaming.py`: an SSE response that always closes its generator, so a browser disconnect
  (Stop) reliably saves the partial reply and aborts the Ollama request. Replies left "streaming" by a crash
  are marked cancelled at startup. One generation per conversation at a time (409 otherwise).
- `core/context/budget.py`: keeps the newest messages that fit the context window and reports how many were left out.
- Endpoints: `GET /api/models`, `GET|POST /api/conversations`, `GET /api/conversations/{id}`,
  `POST /api/conversations/{id}/messages` (SSE).
- FastAPI's built-in OpenTelemetry instrumentation is switched off explicitly (it exports nothing by
  default, but environment variables could otherwise enable it).
- Web UI: chat view with composer (Enter sends, Shift+Enter adds a newline), streaming text, a Stop button, a
  model selector (defaults to your last choice, otherwise the smallest installed model), and generation
  controls (temperature, top-p, max tokens, context window). Recents list in the sidebar. Clear states for
  "API not running", "Ollama not running" and "no models installed". The reply keeps streaming if you navigate away.

Verified:
- 91 backend tests, including 2 live tests against the real Ollama: streamed tokens with usage counts, and
  stopping mid-reply returns in under 2 s with Ollama immediately serving the next request.
- 42 frontend tests, including a hydration regression test (confirmed to fail without the fix).
- Manual run with `llama3.2` (3.2B) in the browser: tokens stream visibly (about 110 characters/s), Stop saves the partial
  reply as "Stopped" (the server log matches: 354 characters, status `cancelled`), and the conversation and title survive a reload.
  First token: about 10 s on a cold model load, about 2 s once loaded.

Fixed during verification:
- Hydration mismatch on `/chat/[id]`: with partial prerendering, the sidebar fetched API health before the chat
  segment hydrated. `useApiHealth` now reports "pending" until hydration completes.
- Never run `next build` while `next dev` is running: both use `apps/desktop/.next`.

Deferred to Milestone 5: Markdown and code highlighting, edit/regenerate/continue, retry, rename/delete/pin/archive,
folders, conversation search and export, model-generated titles.

### Milestone 5: complete chat (2026-11-06)
Built:
- Message tree: editing a message or regenerating a reply adds a new version beside the old one; nothing is
  overwritten. `conversations.current_leaf_id` (migration `0003`) marks the branch shown, and each message
  reports `sibling_ids` so the UI can show "‹ 2 / 3 ›" switchers. Retry is a regenerate of a failed reply.
- Continue: a stopped, failed-with-text or length-limited reply is resumed by sending it back as the last
  assistant message (Ollama treats it as a prefix). The new text is appended to the same message. Only the last
  reply in a branch can be continued.
- Conversations: rename, pin (pinned first), archive, move to folders, delete (audited, with confirmation),
  search over titles and message text (portable LIKE with escaped wildcards), export to Markdown (selected
  branch) or JSON (full tree, `clawde.conversation.v1`).
- Folders and prompt templates (table `prompt_templates`) with full CRUD. Deleting a folder keeps its conversations.
- JSON mode: `params.response_format = "json"` maps to Ollama's `format: "json"`. The `done` event reports `json_valid`.
- Web UI: Markdown (GFM tables, task lists) with highlight.js code blocks, language label and copy. Raw HTML in
  model output is not rendered, and Markdown images are not loaded (no tracking pixels). Message actions
  (copy, edit, regenerate, retry, continue, version switcher), timestamps, a chat header with the conversation
  menu, pinned and recent conversations with menus in the sidebar, an "All chats" page (search, All / Pinned /
  Archived, folder filters and management), conversation search in `Ctrl+K`, a templates menu and a JSON mode
  toggle in the composer.

Verified:
- 104 backend tests (including branching, edit of the first message, cross-conversation id rejection, continue
  rules, search wildcard escaping, export formats, delete audit without content, JSON mode).
- 56 frontend tests (Markdown safety, live-turn merging for send/edit/regenerate/continue, edit/regenerate/
  version-switch/continue flows).
- 2 Playwright end-to-end tests in the installed Microsoft Edge against the real stack (production web build on
  :3100, API on :8100 with a temporary data folder, Ollama with `llama3.2`): send, stream, reload,
  rename, export download, search, delete with confirmation; and stop, partial reply kept, continue, stop again.

Fixed during verification:
- Exported files were named `conversation.md`: the browser hid `Content-Disposition` from the web UI because
  CORS didn't expose it. The API now exposes it (covered by a backend test). Found by the end-to-end test.

Notes:
- Titles are still taken from the first message. Model-generated titles were left out on purpose: on this
  CPU-only machine they would add a second slow generation to every new chat. Rename is available instead.
- Search uses LIKE, not FTS5, so the same code works on PostgreSQL. It is fine for thousands of conversations;
  an indexed search can replace it if needed.

## Known limitations (current)
- CPU-only inference: 7B models run at about 5 tok/s, so small models are the default for interactivity.
- Fine-tuning is limited to small base models; QLoRA and 7B training are out of scope without an NVIDIA GPU.
- The Python sandbox fallback without Docker is weaker isolation and is labelled as such.
- GPU telemetry for Intel iGPU is limited to utilisation counters.
