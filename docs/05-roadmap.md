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
| 6 | Files & documents | Upload validation (size/type/magic), extraction for all listed types, previews, status + errors, chunking, embeddings, chat-with-file | ✅ Done: see progress log |
| 7 | Projects | Project CRUD, instructions, knowledge, scoped chats, per-project FAISS, search, export/delete | ✅ Done: see progress log |
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

### Milestone 6: file uploads and documents (2026-11-06)
Built:
- `POST /api/attachments` (multipart, CSRF): the extension must match the content (PDF, ZIP/Office and image
  signatures; text must not contain NUL bytes). Windows, Linux and macOS executables are refused whatever their name.
  Size limit 25 MB (`CLAWDE_MAX_UPLOAD_BYTES`), with its own body limit so the 1 MiB JSON limit still applies elsewhere.
  Files are stored as `uploads/<id>/original.<ext>`, and the user's filename is only used for display.
- Background extraction (status `pending` → `processing` → `ready` | `failed`, resumed after a restart):
  - PDF (pypdf, page markers, scans without a text layer are flagged, encrypted files refused)
  - DOCX (headings, lists, tables), XLSX (cached values only, formulas never evaluated)
  - CSV/TSV (delimiter sniffing), JSON (validated and pretty-printed), Markdown, text, source code
  - Images (Pillow verification, decompression-bomb guard)
  - Office zip-bomb checks; page, row and 2 million character caps.
- Chunking along paragraph and sentence boundaries with overlap. Chunks are embedded when an embedding-capable model
  is installed (none is yet; BM25 keyword ranking works without one).
- Chat with files: `attachment_ids` on send (edits keep the original's files). Each turn puts all files in the
  current branch into one system block: the full text if it fits the context budget, otherwise the passages most
  relevant to the latest question, in document order. The block is marked as untrusted reference data, and a
  document can't close its wrapper tag (prompt-injection defence). Vision models receive image bytes; text-only
  models are told an image is attached but they can't see it.
- Previews: extracted text (paged) and inline images. Originals download with a sandbox CSP and `nosniff`.
  Unsent files can be deleted, and deleting a conversation removes its files from disk (audited, with counts only).
- Web UI: attach button, drag-and-drop and paste. Chips show upload progress, then "reading", ready, or the reason it
  failed. Sending waits for processing; failed files must be removed first. A warning appears when the selected
  model can't see images, file chips show on sent messages with a preview dialog, and a note says whether the full
  text or excerpts were used.

Verified:
- 156 backend tests: real generated PDF/DOCX/XLSX/PNG/CSV/JSON/code/cp1252 files, 8 rejection cases, a zip bomb,
  the size limit with cleanup, path-traversal filenames, untrusted wrapping and tag escaping, relevant excerpts
  from a long file, the embeddings path, the vision path, attachment ownership rules, file removal on delete,
  resuming after a restart.
- 61 frontend tests, including upload with CSRF, the processing wait, rejection display, blocking send, the image
  warning and preview.
- 3 end-to-end tests against the real stack: llama3.2 answered a question with a made-up code
  (`PELICAN-4471`) that existed only in the uploaded file, and a `.exe` was rejected with a clear message.

Limitations:
- No OCR: scanned PDFs and text inside images can't be read. The UI says so.
- No installed model can see images (none advertises `vision`). The vision path is covered by tests with a test
  provider but not with a real model.
- No embedding model is installed, so retrieval is keyword-based (BM25) until one is pulled, e.g. `nomic-embed-text`
  (a ~270 MB download, needs internet once).

### Milestone 7: projects (2026-11-06)
Built:
- Projects API: create, list (with chat and file counts), update name/description/instructions, archive (no new chats
  while archived), delete (all chats, knowledge files on disk and the search index; audited with counts only).
- Project knowledge: `POST /api/projects/{id}/knowledge` reuses the upload pipeline (same validation and extraction)
  and stores files with `attachments.project_id` (migration `0005`). Up to 200 files per project.
- Retrieval per project (`services/retrieval/project_index.py`): BM25 over the project's chunks always, plus a FAISS
  `IndexFlatIP` (cosine) per project at `<data_dir>/indexes/project-<id>.faiss` when chunks have embeddings. The
  index is rebuilt automatically when the chunk set changes (signature check), written atomically, and treated as
  disposable (a corrupt file is rebuilt). Candidates from both are blended by the existing ranker.
- Project chats: the project's instructions lead the system prompt, followed by the most relevant passages from the
  project's knowledge (or the full text if it fits), marked `source="project knowledge"`, alongside any files
  attached to the chat. All system content is sent as one message so it works the same on every backend.
- Isolation: every retrieval starts from a database filter on the project id, and each project has its own index
  file. Project search covers only that project's chats and files.
- Export: a zip with `project.json` (`clawde.project.v1`), every chat as JSON, and the knowledge files (original +
  extracted text).
- Web UI: projects list (active/archived, counts, empty state, create dialog); project page with instructions editor,
  knowledge panel (upload with progress, drag-and-drop, status, preview, remove), the project's chats, project
  search, and a menu to edit/archive/export/delete with an explicit confirmation of what is lost; "New chat" inside a
  project; a project breadcrumb in the chat header; projects in `Ctrl+K`.

Verified:
- 166 backend tests, including isolation with BM25 and with FAISS vectors (two projects with conflicting
  "vault codes": each chat sees only its own), index rebuild after a file is removed, export contents, complete
  deletion, the single system message, FAISS persist/reload/dimension check/corruption recovery.
- 66 frontend tests (projects list, create, instructions save, knowledge upload to the project endpoint, delete
  confirmation).
- 4 end-to-end tests: llama3.2 answered with a codename that existed only in "Garden Club"'s knowledge file, a new
  chat in "Chess Club" did not reveal it, and project search found the file only in Garden Club.

Fixed during verification:
- `IndexMeta` couldn't be serialised (slots dataclass): building any vector index would have crashed. Found by the
  isolation test with vectors.
- Backend test setup now copies a database migrated once per session (suite: 121 s → 30 s).
- An early E2E failure looked like Ollama dropping a second system message. Testing Ollama directly showed it
  doesn't (the test had clicked the sidebar's "New chat"). Merging into one system message was kept as a backend-
  independent safeguard, with the reason documented accurately.

Deferred: project memory is part of the memory system (Milestone 8).

## Known limitations (current)
- CPU-only inference: 7B models run at about 5 tok/s, so small models are the default for interactivity.
- Fine-tuning is limited to small base models; QLoRA and 7B training are out of scope without an NVIDIA GPU.
- The Python sandbox fallback without Docker is weaker isolation and is labelled as such.
- GPU telemetry for Intel iGPU is limited to utilisation counters.
