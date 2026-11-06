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

### Error codes
`no_session`, `session_expired` (401) · `csrf_failed`, `origin_not_allowed` (403) · `body_too_large` (413) ·
`bad_content_length` (400).

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
| `CLAWDE_LOG_LEVEL` | `INFO` | |
| `CLAWDE_AUTO_MIGRATE` | `true` | Apply migrations on startup |
