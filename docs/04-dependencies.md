# CLAWDE — Dependency List

All dependencies are free and open-source, so the ₹0 budget holds. Exact versions are pinned in `pnpm-lock.yaml`
and `uv.lock` when each package is first added, not guessed here.

## Frontend (`apps/desktop`)
| Package | Purpose |
|---|---|
| next, react, react-dom, typescript | App framework |
| tailwindcss | Styling |
| shadcn/ui (radix-ui primitives, class-variance-authority, `cn` class merger, cmdk, tw-animate-css) | Accessible components (copied into repo) |
| geist, @fontsource-variable/newsreader | Fonts bundled locally (no Google Fonts fetch, works offline) |
| cross-env | Disables Next.js telemetry cross-platform in npm scripts |
| motion | Subtle animations |
| lucide-react | Icons |
| @tanstack/react-query | Server state, caching, retries |
| zustand | Small client UI state |
| react-markdown, remark-gfm | Markdown (GFM) |
| rehype-highlight, highlight.js | Syntax highlighting (theme colours defined in globals.css) |
| @codemirror/* (via @uiw/react-codemirror) | Artifact source editor |
| diff | Artifact version comparison |
| zod | Validate API responses |
| vitest, @testing-library/react, @playwright/test | Unit + E2E tests (E2E uses the installed Edge/Chrome) |
| eslint, prettier | Lint / format |

## Artifact sandbox (vendored static files, served offline)
react / react-dom UMD, @babel/standalone, mermaid, chart.js or vega-lite, marked, DOMPurify.

## Backend (`apps/api`, Python 3.12 via uv)
| Package | Purpose |
|---|---|
| fastapi, uvicorn[standard], pydantic v2, pydantic-settings | API, config |
| sse-starlette | SSE streaming |
| sqlalchemy 2, alembic, aiosqlite | ORM, migrations (PG-compatible) |
| httpx | Talk to Ollama / llama-server |
| structlog | Structured logging |
| python-multipart, python-magic-bin (or `filetype`) | Uploads, content sniffing |
| pypdf (+ pdfplumber), python-docx, openpyxl, pandas, Pillow | Document extraction |
| tiktoken or HF tokenizers | Token counting for budgets |
| faiss-cpu, numpy | Vector index |
| sentence-transformers | Local embeddings (alternative to Ollama embeddings) |
| psutil | RAM/CPU monitoring |
| gguf | GGUF metadata parsing |
| huggingface_hub | Opt-in downloads (behind NetworkGate) |
| docker (SDK) | Sandbox tier 1 |
| pytest, pytest-asyncio, httpx test client, ruff, mypy | Tests, lint, types |

## Research Studio (optional extra: `uv sync --extra research`)
torch (CPU wheel; optionally the XPU build for Intel Arc), transformers, peft, datasets, tokenizers, accelerate,
evaluate, safetensors.

## External runtimes
| Runtime | Status | Needed for |
|---|---|---|
| Ollama | Installed 0.32.6 | Default inference (M4); embeddings from M6 |
| llama.cpp `llama-server` (prebuilt Windows CPU / Vulkan) | To install in M11 | Direct GGUF serving |
| Docker Desktop | Installed | Hardened Python sandbox (optional) |
| Tesseract OCR | Optional | Text from images / scanned PDFs |

## Explicitly not used
No paid AI APIs, no telemetry or analytics SDKs, no cloud databases, no hosted vector DBs.
