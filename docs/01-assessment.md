# CLAWDE — Milestone 1: Repository Audit & Hardware Assessment

Audit date: 2026-11-06. Everything below was measured on this machine, not estimated.

## 1. Repository assessment

| Check | Result |
|---|---|
| Location | `C:\dev\clawde` (moved out of OneDrive on 2026-11-06) |
| Files present | **0** (empty directory; greenfield build) |
| Git repository | Initialised on 2026-11-06 (`main`) |
| Existing components to preserve | None |

**Risk: the project folder is inside OneDrive.** OneDrive sync conflicts with:
- `node_modules/` and `.venv/` (hundreds of thousands of files, constant sync churn),
- SQLite databases in WAL mode (sync locking can corrupt the `-wal`/`-shm` files),
- FAISS index files and model checkpoints that are rewritten often (multi-GB uploads).

Recommendation: move the source tree to a non-synced path (e.g. `C:\dev\clawde`). In every case, runtime data
(DB, vector indexes, uploads, checkpoints) defaults to `%LOCALAPPDATA%\Clawde\` and never lives in the repo.

## 2. Hardware compatibility report

| Component | Measured | Implication |
|---|---|---|
| CPU | Intel Core Ultra 5 125H, 14 cores / 18 threads | Good CPU inference with llama.cpp (AVX2/AVX-VNNI) |
| RAM | 15.5 GB total, **2.1 GB free** at audit time (other apps open) | Load one model at a time; memory-aware routing is required |
| GPU | Intel Arc integrated (shared memory), **no NVIDIA / no CUDA** | Ollama ran with `size_vram = 0`, so inference is CPU-only today |
| Disk | 73.7 GB free on C: | Room for about 8–10 more 7B GGUF models, or datasets and checkpoints |
| OS | Windows 11 Home 10.0.26200 | Native dev; WSL2 and Docker available as options |

### Measured inference throughput (Ollama 0.32.6, CPU)

| Model | Size on disk | Load (cold) | Generation speed |
|---|---|---|---|
| `llama3.2` (3B, Q4) | 2.0 GB | 6.1 s | **18.1 tok/s** (smooth streaming) |
| `qwen2.5-coder:7b` (Q4) | 4.7 GB | 22.6 s | **5.3 tok/s** (usable, slow) |

Expected range for other sizes (not yet measured): 1–3B models are interactive. 7–8B models work but are slow.
`gemma4` (9.6 GB) will page heavily under current RAM pressure. 14B+ is not practical.

### Models already installed in Ollama
`llama3.2:latest` (3B) · `llama3.1:8b` (= `llama3.1:latest`, same ID) · `qwen2.5-coder:7b` (= `:latest`, same ID) ·
`mistral:latest` (7B) · `codellama:latest` (7B) · `gemma4:latest` (9.6 GB).
No embedding model is installed yet (planned: `nomic-embed-text` via Ollama, or `all-MiniLM-L6-v2` via Sentence Transformers).

### Training feasibility (honest limits)

| Workload | Feasible here? |
|---|---|
| Tiny transformer from scratch (1–20M params, char/BPE, small corpus) | **Yes**, on CPU, minutes to hours |
| LoRA fine-tune of 0.5B-class model (e.g. Qwen2.5-0.5B) on small dataset | **Yes, slowly**, on CPU (hours), fp32/bf16 |
| LoRA fine-tune of 1.5B model | Marginal (RAM-bound) |
| QLoRA / 7B fine-tune | **No**: `bitsandbytes` 4-bit needs CUDA; 7B does not fit |
| Intel XPU (Arc iGPU) PyTorch backend | Experimental, to benchmark in M12; shares system RAM |
| Free cloud GPU (Kaggle/Colab) | Possible as an **opt-in, internet-requiring** export path. Never default |

## 3. Toolchain

| Tool | Found | Notes |
|---|---|---|
| Node.js | v22.22.3 | OK for Next.js |
| pnpm | 11.10.0 | Package manager for the frontend |
| uv | 0.11.26 | Python env and lock management |
| Python | 3.11–3.14 installed | Use **3.12** for the project venv (best wheel coverage for torch, faiss-cpu, sentence-transformers on Windows) |
| ⚠ `python` on PATH | `...\hermes\hermes-agent\venv\Scripts\python.exe` | Belongs to another app's venv; the project must **not** use it. Scripts will call `uv run` |
| Git | 2.54 | OK |
| Docker | 29.6.1 (Docker Desktop) | Optional; used for the hardened Python sandbox |
| Ollama | 0.32.6 (0.40.15 available) | Working; server on `127.0.0.1:11434` |
| llama.cpp `llama-server` | **Missing** | Install prebuilt Windows binary in M11 (CPU, plus Vulkan build to test Arc iGPU offload) |
| CUDA / nvcc | Missing | Not applicable (no NVIDIA GPU) |

Note: running `ollama list` during the audit started the Ollama desktop app, which was not running before.
