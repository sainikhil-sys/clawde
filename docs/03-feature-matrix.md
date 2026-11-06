# CLAWDE — Feature Implementation Matrix

Status: ⬜ not started · 🟨 in progress · ✅ done and tested · ⚠ hardware-limited (works with documented limits)

| Area | Feature | Milestone | Feasibility on this machine | Status |
|---|---|---|---|---|
| Chat | New / history / search / rename / delete / archive / pin / folders | M5 | Full | ⬜ |
| Chat | Streaming and stop (partial reply kept) | M4 | Full | ✅ |
| Chat | Continue and retry | M5 | Full | ⬜ |
| Chat | Markdown + syntax highlighting, copy, timestamps | M5 | Full | ⬜ |
| Chat | Edit message / regenerate (branching) | M5 | Full | ⬜ |
| Chat | Export (Markdown, JSON) | M5 | Full | ⬜ |
| Files | PDF, TXT, MD, DOCX, CSV, XLSX, JSON, code | M6 | Full | ⬜ |
| Files | Images: preview + metadata; understanding needs a vision model | M6 | ⚠ vision models are slow on CPU; OCR optional (Tesseract) | ⬜ |
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
| Projects | CRUD, instructions, knowledge uploads, scoped chats | M7 | Full | ⬜ |
| Projects | Semantic retrieval, project search, isolation | M7 | Full | ⬜ |
| Projects | Export / delete (incl. index + files) | M7 | Full | ⬜ |
| Memory | 5 memory kinds, CRUD, inspect, search, rank | M8 | Full | ⬜ |
| Memory | Conversation summarisation | M8 | Full (uses a 3B model for speed) | ⬜ |
| Artifacts | HTML/CSS/JS, SVG, Markdown, Mermaid, React, charts | M9 | Full (React via vendored Babel, offline) | ⬜ |
| Artifacts | Editor, versions, diff, fullscreen, export | M9 | Full | ⬜ |
| Agents | Planner, multi-step, retry, cancel, approvals, history | M10 | Full; reliability depends on model (7B recommended) | ⬜ |
| Agents | Tools: file read/write, doc search, calculator, JSON, knowledge, project search | M10 | Full | ⬜ |
| Agents | Sandboxed Python | M10 | Docker tier full; fallback tier ⚠ reduced isolation | ⬜ |
| Intelligence | RAG, doc QA, summarisation, code gen/explain/debug | M6–M8 | Full | ⬜ |
| Intelligence | JSON mode / structured output | M5 | Full (Ollama `format` schema + validation) | ⬜ |
| Intelligence | Tool calling | M10 | Native where supported, JSON fallback otherwise | ⬜ |
| Intelligence | Prompt templates | M5 | Full | ⬜ |
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
| UX | Sidebar with 8 sections, collapse, mobile drawer | M2 | Full | ✅ |
| UX | Keyboard navigation: skip link, `Ctrl+K` palette, `Ctrl+.` sidebar, focus rings | M2 | Full | ✅ |
| UX | Command palette: conversation and project search | M5, M7 | Full | ⬜ |
