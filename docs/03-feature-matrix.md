# CLAWDE — Feature Implementation Matrix

Status: ⬜ not started · 🟨 in progress · ✅ done and tested · ⚠ hardware-limited (works with documented limits)

| Area | Feature | Milestone | Feasibility on this machine | Status |
|---|---|---|---|---|
| Chat | New / history / search / rename / delete / archive / pin / folders | M5 | Full | ✅ |
| Chat | Streaming and stop (partial reply kept) | M4 | Full | ✅ |
| Chat | Continue and retry | M5 | Full | ✅ |
| Chat | Markdown + syntax highlighting, copy, timestamps | M5 | Full | ✅ |
| Chat | Edit message / regenerate (branching, version switcher) | M5 | Full | ✅ |
| Chat | Export (Markdown, JSON) | M5 | Full | ✅ |
| Files | PDF, TXT, MD, DOCX, CSV, XLSX, JSON, code: validation, extraction, previews, status, errors | M6 | Full | ✅ |
| Files | Images: preview + metadata, sent to vision models | M6 | ⚠ no vision model installed yet; no OCR | ✅ |
| Models | Ollama adapter: list, metadata, chat streaming | M4 | Full | ✅ |
| Models | Ollama adapter: pull, delete, embeddings | M6, M11 | Full | ⬜ |
| Models | llama.cpp adapter (llama-server) | M11 | Full (CPU); Vulkan iGPU to test | ⬜ |
| Models | Hugging Face / Transformers adapter | M11 | ⚠ small models only (≤1.5B) for in-process inference | ⬜ |
| Models | GGUF import, metadata, licence, hardware fit | M11 | Full | ⬜ |
| Models | Sampling params, context length, max tokens | M4 | Full | ✅ |
| Models | Provider-independent registry (synced, not hardcoded) and model switching | M4 | Full | ✅ |
| Models | RAM monitoring | M11 | Full (psutil) | ⬜ |
| Models | GPU monitoring | M11 | ⚠ Intel iGPU: utilisation via Windows perf counters only, no VRAM split | ⬜ |
| Models | Behaviour profiles | M11 | Full | ⬜ |
| Models | Multi-model router (auto + manual, RAM-aware) | M11 | Full; one large model resident at a time | ⬜ |
| Projects | CRUD, instructions, knowledge uploads, scoped chats, archive | M7 | Full | ✅ |
| Projects | Retrieval (BM25 + per-project FAISS), project search, isolation | M7 | Full; vectors once an embedding model is installed | ✅ |
| Projects | Export (zip) / delete (incl. index + files) | M7 | Full | ✅ |
| Memory | 5 memory kinds, CRUD, inspect, search, rank, export, delete all | M8 | Full | ✅ |
| Memory | Conversation summarisation (manual + automatic rolling summary) | M8 | Full; uses the chat's model | ✅ |
| Artifacts | HTML/CSS/JS, SVG, Markdown, Mermaid, React, charts, JavaScript, code | M9 | Full (offline; vendored React/Babel/Mermaid/Chart.js) | ✅ |
| Artifacts | Editor, versions, diff, restore, fullscreen, copy, export | M9 | Full | ✅ |
| Artifacts | Isolated sandbox (separate origin, opaque iframe, no network) | M9 | Full | ✅ |
| Agents | Planner, multi-step, retry, cancel, approvals, history, live updates | M10 | Full; reliability depends on model (7B recommended) | ✅ |
| Agents | Tools: file read/list/write, doc search, calculator, JSON, knowledge, project search | M10 | Full | ✅ |
| Agents | Tool permissions (allow / ask / off; write and execute always ask), workspace confinement, audit | M10 | Full | ✅ |
| Agents | Sandboxed Python | M10 | Fallback ✅ (⚠ reduced isolation, labelled); Docker tier built, not yet run on a real engine | ✅ |
| Intelligence | Document QA over attachments (full text or ranked excerpts) | M6 | Full; keyword ranking until an embedding model is installed | ✅ |
| Intelligence | Project-wide RAG (FAISS) | M7 | Full | ✅ |
| Intelligence | Conversation summarisation | M8 | Full | ✅ |
| Intelligence | JSON mode / structured output | M5 | Full (Ollama `format: json` + validity check) | ✅ |
| Intelligence | Tool calling | M10 | Native where supported, JSON fallback otherwise | ⬜ |
| Intelligence | Prompt templates | M5 | Full | ✅ |
| Evaluation | Suites incl. refusal behaviour, latency, RAM | M11–M13 | Full (slow for 7B; runs are queued) | ⬜ |
| Research | Datasets: import, inspect, split, stats | M12 | Full | ⬜ |
| Research | Tokenizer experiments (train BPE, compare) | M12 | Full | ⬜ |
| Research | Tiny transformer training from scratch | M12 | ⚠ CPU: ≤20M params | ⬜ |
| Research | LoRA fine-tuning (PEFT), adapter mgmt, logs, checkpoints | M12 | ⚠ CPU: ≤0.5–1.5B base models, hours per run | ⬜ |
| Research | Benchmarks & model comparison | M12 | Full | ⬜ |
| Research | Merge LoRA → GGUF → register in library | M12 | ⚠ needs llama.cpp convert scripts; small models only | ⬜ |
| Security | Session, CSRF, Host check, Origin/CORS, validation, size limits, path safety | M3 | Full | ✅ |
| Security | Audit log (API + Settings view) | M3 | Full | ✅ |
| Security | Export & delete all data | M13 | Full | ⬜ |
| Storage | SQLite + Alembic migrations, PostgreSQL-compatible models | M3 | Full | ✅ |
| Storage | Structured JSON logs | M3 | Full | ✅ |
| UX | Light/dark/system theme, persisted, no flash | M2 | Full | ✅ |
| UX | Sidebar with 9 sections (Memory added in M8), collapse, mobile drawer | M2 | Full | ✅ |
| UX | Keyboard navigation: skip link, `Ctrl+K` palette, `Ctrl+.` sidebar, focus rings | M2 | Full | ✅ |
| UX | Command palette: conversation search | M5 | Full | ✅ |
| UX | Command palette: project search | M7 | Full | ✅ |
