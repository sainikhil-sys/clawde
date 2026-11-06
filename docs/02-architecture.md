# CLAWDE — System Architecture

## 1. Shape of the system

```
 Browser (localhost:3000)            Sandbox origin (127.0.0.1:3901)
 ┌──────────────────────────┐        ┌─────────────────────────────┐
 │ apps/desktop  (Next.js)  │ iframe │ artifact runtime (static,   │
 │ UI · state · SSE client  │───────►│ vendored React/Babel/       │
 └────────────┬─────────────┘ post-  │ Mermaid, strict CSP, no     │
              │ REST + SSE    Message│ cookies, no API access)     │
              ▼                      └─────────────────────────────┘
 ┌──────────────────────────────────────────────────────────────────┐
 │ apps/api  (FastAPI, 127.0.0.1:8000)                              │
 │  routers → services → core / models / storage                    │
 │  ┌──────────────┐ ┌─────────────┐ ┌──────────────┐ ┌───────────┐ │
 │  │ orchestrator │ │ agents +    │ │ memory +     │ │ evaluation│ │
 │  │ (turn loop,  │ │ tools +     │ │ context mgr  │ │ harness   │ │
 │  │ router)      │ │ permissions │ │ (budgeting)  │ │           │ │
 │  └──────┬───────┘ └─────┬───────┘ └──────┬───────┘ └─────┬─────┘ │
 │         └────── inference gateway (ModelProvider protocol) ──────┘│
 │            │             │               │              │         │
 └────────────┼─────────────┼───────────────┼──────────────┼─────────┘
              ▼             ▼               ▼              ▼
          Ollama      llama-server    Transformers     Custom/trained
         :11434       (OpenAI API)    (in-process)     (registry entry)

 storage: SQLite (WAL, SQLAlchemy 2 + Alembic) · FAISS per-scope indexes ·
          %LOCALAPPDATA%\Clawde\{db,uploads,indexes,artifacts,models,runs}
 research worker: separate Python process (training never blocks the API)
```

Process model: three local processes (web UI, API, sandbox static server), plus the Ollama server and an optional
training worker. Everything binds to loopback only.

## 2. Key design decisions

| Concern | Decision | Why |
|---|---|---|
| Streaming | **SSE** (`text/event-stream`), typed events: `token`, `tool_call`, `tool_result`, `approval_required`, `done`, `error` | One-directional token streams; works through fetch + AbortController for stop. WebSocket only if needed later |
| Persistence | SQLAlchemy 2.0 ORM + Alembic migrations, SQLite WAL | Same models run on PostgreSQL by changing the URL; no SQLite-only SQL |
| Vector search | FAISS `IndexFlatIP` / `IndexHNSWFlat` **one index per scope** (`global`, `project:<id>`, `memory:<id>`) + chunk table in SQLite | Physical separation enforces project isolation; rebuildable from DB |
| Embeddings | `EmbeddingProvider` interface: Ollama `nomic-embed-text` or Sentence-Transformers `all-MiniLM-L6-v2` | Small, CPU-friendly, swappable; index records embedding model ID so mismatches trigger re-index |
| Model independence | All inference goes through `ModelProvider` and the `ModelRegistry`; app code never imports a backend | Custom models drop in as registry entries + adapter |
| Long context | Context manager with token budgets: system → pinned memory → retrieved chunks → rolling summary → recent turns | Small local context windows (4–32k) make budgeting essential |
| Artifacts | Rendered only in an iframe on a **different origin** (separate port), `sandbox="allow-scripts"` (never `allow-same-origin`), CSP `connect-src 'none'`, communication via validated `postMessage` | Generated code can never touch the app's cookies, DOM, or API |
| Python execution | Tier 1: Docker container `--network none --read-only --memory 512m --cpus 1 --pids-limit`, timeout. Tier 2 (no Docker): subprocess in temp dir, `-I`, Windows Job Object memory/CPU limits, timeout, **labelled "reduced isolation"** and requires per-run approval | Windows has no seccomp; be honest about the weaker fallback |
| Auth | Single local user. Random session token on first run; `HttpOnly; SameSite=Strict` cookie; CSRF header on mutations; `Host`/`Origin` allowlist (blocks DNS rebinding) | Local-first but still defends against malicious web pages calling localhost |
| Logging | `structlog` JSON logs to file + console; separate append-only `audit_log` table for tool calls, approvals, deletions, exports, network-enabled actions | Debuggability + user-visible audit trail |
| Network | Offline by default. Outbound calls (model downloads, HF Hub) go through one `NetworkGate` that checks a user setting and logs every request | "No external requests unless enabled" becomes enforceable and testable |

## 3. Backend module boundaries (maps to repo structure)

| Package | Responsibility | Depends on |
|---|---|---|
| `core/orchestrator` | Chat turn pipeline: build context → route model → stream → persist → post-process (summaries, memory suggestions) | inference, context, memory, tools |
| `core/inference` | `ModelProvider` protocol, gateway, streaming normalization, tool-call parsing (native + JSON-fallback) | models/adapters |
| `core/context` | Token counting, budget allocation, summarization triggers | inference |
| `core/memory` | Memory CRUD, ranking (recency × relevance × importance), scope rules | storage, retrieval |
| `core/agents` | Planner, step executor, retry/recovery, cancellation, checkpoints | tools, permissions, inference |
| `core/tools` | Tool registry (JSON-Schema I/O), built-in tools | permissions |
| `core/permissions` | Scopes, policies, approval queue, non-disableable safeguards | storage |
| `core/evaluation` | Benchmark suites, runners, result storage | inference |
| `models/registry` | Model records, capabilities, metadata, hardware fit | storage |
| `models/adapters` | `ollama`, `llamacpp`, `transformers`, `custom` | — |
| `models/datasets`, `training`, `experiments` | Research Studio | torch, transformers, peft |
| `services/document_processing` | Validation, type sniffing, extraction (PDF, DOCX, XLSX, CSV, JSON, MD, code, images), chunking | — |
| `services/retrieval` | Embed, index, hybrid search (FAISS + SQLite FTS5 BM25), rerank | storage/vector_index |
| `services/conversation` | Conversations, messages, branches (edit/regenerate), folders, export | storage |
| `storage/database`, `vector_index`, `local_files` | Persistence primitives; `local_files` owns path-safe file access | — |

Rule: routers call services, services call core and storage, and core never imports FastAPI.

## 4. Model library, freedom & router (spec §11)

### 4.1 Registry record (not a hardcoded list)
```
Model { id, display_name, provider (ollama|llamacpp|transformers|custom), provider_ref,
        family, architecture, parameter_count, quantization, format (gguf|safetensors|…),
        context_length, license_id, license_text_path, source_url, version/digest,
        size_bytes, est_ram_bytes, capabilities: {chat, code, reasoning, tools, vision,
        embeddings, long_context}, capability_source: declared|detected|evaluated,
        behaviour_profile_id, eval_summary, installed_at, last_used_at }
```
- **Discovery:** each adapter's `list_local()` is synced into the registry (Ollama `/api/tags` + `/api/show`;
  GGUF header parsing for llama.cpp files; `config.json` for HF folders). Any Qwen, DeepSeek, Mistral, Hermes,
  Dolphin or other compatible model appears automatically. No allowlist.
- **Import:** a local `.gguf` file or HF folder goes through validation, header read, and registration
  (an Ollama `Modelfile` is created on request).
- **Download:** Ollama pull / HF Hub snapshot through `NetworkGate`, with progress via SSE.
- **Hardware fit:** `est_ram = file size × 1.1 + KV cache(context_length)`, compared with free RAM to show
  "fits / tight / won't fit".
- **Licence:** read from GGUF metadata, HF card, or Ollama `license`. Shown in the UI. Restricted licences are
  flagged and never hidden.

### 4.2 Behaviour profiles
A profile is a user-editable preset: system instructions, response style, temperature, top-p, max tokens,
reasoning settings (e.g. thinking on/off where the model supports it), context strategy, and tool permissions.
Profiles attach to a model, a project, or a conversation (most specific wins).

### 4.3 Router
`auto` mode classifies the request into a task type (`chat | code | math | document | agent | embed`) with
fast heuristics (code fences, file attachments, math symbols, agent mode). An optional small-model classifier can
be enabled later. The router then picks the user's assigned model for that task, filtered by required capability
(e.g. `tools` for agents) and **RAM fit**. Only one large model stays resident (`keep_alive` management), so
switching models unloads the previous one. Manual selection always overrides routing, and every response records
which model answered and why.

### 4.4 Evaluation and honest behaviour reporting
Suites: instruction following, coding (pass@1 on bundled small tasks executed in the sandbox), reasoning (math
with exact-match), hallucination (closed-book questions with known answers + "unanswerable" probes), **refusal
behaviour** (benign-but-edgy prompts that should be answered, plus clearly harmful prompts that should be
declined, scored both ways as over-refusal and under-refusal), tool-call validity, latency, RAM peak, and
GPU use where measurable. Runs are reproducible (fixed seed, temperature 0, suite version hash) and stored per
model version.

The UI shows **observed** behaviour from these evaluations. It never shows "unrestricted" or similar claims. Model
*capabilities* (what it can do) and model *policies* (what it declines) are reported separately.

### 4.5 Safety layers that do not depend on the model
Whatever model is loaded, including community fine-tunes with fewer refusals, these app-level controls stay on and
cannot be turned off from settings:
- Tools are scoped: the file tools are confined to a workspace root (resolved-path check, symlink rejection).
  There is no network tool by default, and writes, deletions and code execution require approval.
- Code runs only in the sandbox.
- Prompt-injection defences: retrieved and tool content is wrapped as untrusted data. Tool calls originating
  after untrusted content was read require approval, and the agent cannot grant itself permissions.
- No credential harvesting surfaces: tools cannot read browser profiles, keychains, or `.env` outside the workspace.
- Model licences are displayed and respected. The platform never strips or patches a provider's safeguards.

Configurable layers: refusal transparency (show "model declined" vs. retry with another model), content
policy presets for chat, and per-tool approval levels.

## 5. Data model (initial tables)

`users`(single row) · `sessions` · `settings` · `folders` · `projects` · `project_files` ·
`conversations`(project_id nullable, pinned, archived, folder_id) · `messages`(parent_id for edit/regenerate
branches, role, content, model_id, token counts, status) · `attachments` · `documents` · `chunks`(scope, doc_id,
text, embedding_model, faiss_id) · `memories`(scope, kind: preference|summary|project|knowledge|temp, content,
importance, source, expires_at) · `artifacts` · `artifact_versions` · `models` · `behaviour_profiles` ·
`agent_runs` · `agent_steps` · `approvals` · `tool_permissions` · `eval_suites` · `eval_runs` · `eval_results` ·
`datasets` · `training_runs` · `checkpoints` · `adapters_lora` · `audit_log`.
Full column-level schema will live in `docs/database.md`, generated from the ORM in Milestone 3.

## 6. Internet-requiring functions (disclosed in UI)
Downloading models (Ollama registry, Hugging Face), downloading datasets, installing dependencies, and the optional
cloud-GPU export. Everything else works offline after installation.
