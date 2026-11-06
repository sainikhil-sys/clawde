# CLAWDE — API Reference

Base URL: `http://127.0.0.1:8000`. With the API running, live OpenAPI docs are at
`/api/docs`, and the raw schema is at `/api/openapi.json`.

## Conventions

- **Errors** use `{"detail": {"code": "<machine_code>", "message": "<human text>"}}`. Validation errors (422)
  use FastAPI's standard `detail` list.
- **Sessions:** the web UI calls `POST /api/session` once. The response sets an `HttpOnly; SameSite=Strict`
  cookie and returns a CSRF token.
- **CSRF:** every `POST`/`PUT`/`PATCH`/`DELETE` on a session-protected route needs the header
  `X-CSRF-Token: <token>`.
- **Origin:** state-changing requests that carry an `Origin` header must come from an allowed origin
  (default `http://127.0.0.1:3000`, `http://localhost:3000`).
- **Host:** requests with any `Host` header other than `127.0.0.1` or `localhost` are rejected (400). This
  blocks DNS rebinding.
- **Body size:** JSON bodies are limited to 1 MiB by default (`413 body_too_large`).
- Every response carries `X-Request-ID`, which matches the `request_id` field in the logs.

## Endpoints (Milestone 3)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | none | `{status, version, database: {status, revision, head_revision}}`. `degraded` when migrations are behind |
| POST | `/api/session` | allowed `Origin` | Creates a session, sets cookie, returns `{csrf_token, created_at, expires_at}` (201) |
| GET | `/api/session` | cookie | Returns the current session's CSRF token (used after a page reload) |
| DELETE | `/api/session` | cookie + CSRF | Ends the session and clears the cookie (204) |
| GET | `/api/settings` | cookie | `{network_access_enabled, default_model}` |
| PATCH | `/api/settings` | cookie + CSRF | Partial update; unknown keys → 422; changes are audited |
| GET | `/api/audit?limit=50&before_id=` | cookie | Newest-first audit events, `{events, next_before_id}` |
| GET | `/api/models?include_unavailable=false` | cookie | Syncs the registry with all providers, returns `{models, providers}`. Each model has `chat: bool` |
| GET | `/api/conversations?archived=&pinned=&folder_id=&limit=&offset=` | cookie | Pinned first, then most recently updated, with `message_count` |
| GET | `/api/conversations/search?q=&limit=20` | cookie | Title and message-text matches: `[{conversation, match, snippet, message_id}]` |
| PATCH | `/api/conversations/{id}` | cookie + CSRF | `{title?, pinned?, archived?, folder_id?}`; `folder_id: null` removes it from its folder |
| DELETE | `/api/conversations/{id}` | cookie + CSRF | Deletes the conversation and all its messages (audited) |
| GET | `/api/conversations/{id}/export?format=markdown\|json` | cookie | File download (`Content-Disposition: attachment`) |
| PUT | `/api/conversations/{id}/branch` | cookie + CSRF | `{message_id}` → show the branch containing that message |
| POST | `/api/conversations/{id}/regenerate` | cookie + CSRF | `{message_id, model_id?, params?}` → SSE. New alternative reply (also used for retry) |
| POST | `/api/conversations/{id}/continue` | cookie + CSRF | `{message_id, params?}` → SSE. Appends to a stopped / length-limited reply |
| GET/POST | `/api/folders` | cookie (+ CSRF) | List (with `conversation_count`) / create `{name}` |
| PATCH/DELETE | `/api/folders/{id}` | cookie + CSRF | Rename / delete (conversations are kept) |
| GET/POST | `/api/templates` | cookie (+ CSRF) | List / create `{name, content}` |
| PATCH/DELETE | `/api/templates/{id}` | cookie + CSRF | Update / delete |
| POST | `/api/conversations` | cookie + CSRF | `{title?, model_id?}` → conversation (201) |
| GET | `/api/conversations/{id}` | cookie | Conversation with the selected branch's messages; each has `sibling_ids` and `finish_reason` |
| POST | `/api/conversations/{id}/messages` | cookie + CSRF | `{content, model_id?, params?, edit_of?}` → **SSE stream** (see below). `edit_of` makes the message a new version of an earlier user message |

### Streaming a reply
The `params` field takes `{temperature 0–2, top_p 0–1, max_tokens 1–32768, context_length 512–131072, seed?,
response_format: "text" | "json"}`.
The context length is capped at the model's maximum. The model is chosen in this order: the request, then the
conversation's last model, then the `default_model` setting. Otherwise the request fails with 400 `no_model_selected`.

Events (`text/event-stream`, each `data:` is JSON):
| Event | Data |
|---|---|
| `start` | `{conversation, user_message, assistant_message, history_messages_dropped}` |
| `token` | `{text}`, repeated |
| `done` | `{message, finish_reason, total_duration_ms, load_duration_ms}` |
| `error` | `{code, message, message_id}`. Partial text is saved on the message |

Closing the connection stops generation. The partial reply is saved with status `cancelled`.

### Error codes
`no_session`, `session_expired` (401) · `csrf_failed`, `origin_not_allowed` (403) · `body_too_large` (413) ·
`bad_content_length` (400) · `conversation_not_found` (404) · `no_model_selected`, `model_unavailable`,
`model_not_chat`, `nothing_to_regenerate`, `cannot_continue` (400) · `message_not_found`, `folder_not_found`,
`template_not_found` (404) · `generation_in_progress` (409) · stream errors: `provider_unavailable`, `model_not_found`,
`provider_error`.

## CLI

```bash
uv run clawde-api serve --reload
```

```bash
uv run clawde-api migrate
```

```bash
uv run clawde-api downgrade -1
```

```bash
uv run clawde-api info
```

## Configuration (`CLAWDE_*` environment variables or `.env`)

| Variable | Default | Purpose |
|---|---|---|
| `CLAWDE_DATA_DIR` | `%LOCALAPPDATA%\Clawde` | Database, logs and (later) uploads, indexes, models |
| `CLAWDE_DATABASE_URL` | SQLite file in data dir | Any SQLAlchemy async URL (e.g. `postgresql+asyncpg://…`) |
| `CLAWDE_HOST` / `CLAWDE_PORT` | `127.0.0.1` / `8000` | Non-loopback hosts are refused unless `CLAWDE_ALLOW_REMOTE_BIND=true` |
| `CLAWDE_ALLOWED_ORIGINS` | `["http://127.0.0.1:3000","http://localhost:3000"]` | JSON list |
| `CLAWDE_SESSION_TTL_HOURS` | `720` | Session lifetime |
| `CLAWDE_MAX_REQUEST_BYTES` | `1048576` | JSON body limit |
| `CLAWDE_OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama server |
| `CLAWDE_OLLAMA_KEEP_ALIVE` | `10m` | How long Ollama keeps a model in RAM after use |
| `CLAWDE_LOG_LEVEL` | `INFO` | |
| `CLAWDE_AUTO_MIGRATE` | `true` | Apply migrations on startup |
