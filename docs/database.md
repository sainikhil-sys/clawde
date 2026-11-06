# CLAWDE — Database Schema

Source of truth: `storage/database/models.py`. Migrations: `storage/database/migrations/versions/`.
A test (`tests/backend/test_database.py::test_migrations_match_models`) fails if the models and migrations
ever drift apart.

- **Engine:** SQLite in WAL mode with foreign keys enforced. Everything is written with portable SQLAlchemy
  types, so PostgreSQL works by changing `CLAWDE_DATABASE_URL`.
- **Timestamps:** stored as UTC and returned timezone-aware (`UTCDateTime`).
- **IDs:** 32-character hex UUIDs, except `app_sessions` (SHA-256 of the token) and `audit_events`
  (autoincrement).

## Revision `0001_initial` (Milestone 3)

### app_sessions
| Column | Type | Notes |
|---|---|---|
| id | varchar(64) PK | SHA-256 hex of the cookie token; the raw token is never stored |
| csrf_token | varchar(64) | |
| created_at, last_seen_at | datetime | `last_seen_at` updated at most every 5 min |
| expires_at | datetime, indexed | Expired rows are purged when a new session is created |
| user_agent | varchar(300) null | |

### audit_events
| Column | Type | Notes |
|---|---|---|
| id | integer PK autoincrement | |
| created_at | datetime, indexed | |
| actor | varchar(100) | `user`, `system`, later `agent:<run id>` |
| action | varchar(100), indexed | e.g. `session.create`, `settings.update` |
| target_type, target_id | varchar null | |
| details | JSON | Secret-looking keys are refused by `services/audit` |
| client_ip | varchar(45) null | |

### settings
`key` varchar(100) PK · `value` JSON · `updated_at`. Validated by `services/settings/service.py::AppSettings`.

### folders
`id` PK · `name` varchar(200) · `created_at` · `updated_at`.

### projects
`id` PK · `name` varchar(200) · `description` text · `instructions` text · `created_at` · `updated_at` ·
`archived_at` null.

### conversations
| Column | Type | Notes |
|---|---|---|
| id | varchar(32) PK | |
| title | varchar(300) | |
| project_id | FK → projects, `ON DELETE CASCADE`, indexed | null = not in a project |
| folder_id | FK → folders, `ON DELETE SET NULL`, indexed | |
| pinned, archived | boolean | |
| model_id | varchar(200) null | Registry id of the last model used |
| created_at, updated_at | datetime | `updated_at` indexed for the history list |

### messages
| Column | Type | Notes |
|---|---|---|
| id | varchar(32) PK | |
| conversation_id | FK → conversations, `ON DELETE CASCADE` | composite index with `created_at` |
| parent_id | FK → messages, `ON DELETE CASCADE`, indexed | Tree structure: edits and regenerations create sibling branches |
| role | varchar(20) | `system`, `user`, `assistant`, `tool` |
| content | text | |
| status | varchar(20) | `streaming`, `complete`, `error`, `cancelled` |
| model_id | varchar(200) null | |
| prompt_tokens, completion_tokens | integer null | |
| error | text null | |
| created_at | datetime | |

## Revision `0002_model_registry` (Milestone 4)

### models
| Column | Type | Notes |
|---|---|---|
| id | varchar(300) PK | `<provider>:<ref>`, e.g. `ollama:llama3.2:latest` |
| provider, provider_ref | varchar | `provider` indexed |
| display_name, family, parameter_size, quantization, format | varchar | As reported by the provider |
| size_bytes | bigint null | |
| context_length | integer null | Model's maximum; requests are capped to it |
| digest | varchar(128) null | |
| capabilities | JSON list | e.g. `["completion", "tools"]`; chat requires `completion` |
| available | boolean | False when the provider stops listing the model or is unreachable |
| first_seen_at, last_synced_at | datetime | |

Message statuses used from M4: `streaming` → `complete` | `error` | `cancelled`. Replies still `streaming` at
startup (after a crash) become `cancelled`.

Planned tables (attachments, documents, chunks, memories, artifacts, models, agent runs, evaluations, research
runs) are listed in `docs/02-architecture.md` §5 and arrive with their milestones.
