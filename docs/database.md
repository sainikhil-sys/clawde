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

## Revision `0003_branches_templates` (Milestone 5)

- `conversations.current_leaf_id` varchar(32) null: the last message of the branch being shown. There is no FK
  (it would be circular with `messages.conversation_id`); `services/conversation` keeps it valid and falls back
  to the newest message. The upgrade backfills existing conversations.
- `messages.finish_reason` varchar(20) null: `stop`, `length` (can be continued), `cancelled`, `error` or
  backend-specific.
- New table `prompt_templates`: `id` PK · `name` varchar(200) · `content` text · `created_at` · `updated_at`.

## Revision `0004_attachments` (Milestone 6)

### attachments
| Column | Type | Notes |
|---|---|---|
| id | varchar(32) PK | Also the folder name under `uploads/` |
| conversation_id | FK → conversations, `ON DELETE CASCADE`, indexed | Null until the file is sent |
| filename | varchar(255) | Sanitised display name only |
| kind, mime_type | varchar | Validated from extension + content |
| size_bytes, sha256 | bigint, varchar(64) | |
| stored_path | varchar(300) | Relative to `uploads/`, e.g. `<id>/original.pdf` |
| status, error | varchar, text | `pending` → `processing` → `ready` / `failed` |
| extracted_text, char_count, page_count | text, int, int | Capped at 2M characters |
| meta | JSON | Image size, sheets, delimiter, encoding, truncation and `no_text_layer` flags, chunk count, embedding model |
| created_at, processed_at | datetime | |

### message_attachments
`message_id` FK → messages (cascade) + `attachment_id` FK → attachments (cascade), composite PK, `position`. A file can
belong to several messages (an edited message keeps the original's files).

### document_chunks
`id` PK · `attachment_id` FK (cascade) · `ordinal` · `char_start` · `char_end` · `text` · `embedding` JSON null ·
`embedding_model` null. Index on (`attachment_id`, `ordinal`).

## Revision `0005_project_knowledge` (Milestone 7)

- `attachments.project_id` FK → projects, `ON DELETE CASCADE`, indexed: set for project knowledge files (which have
  no conversation and are never linked to a message).
- Vector indexes are files, not tables: `<data_dir>/indexes/project-<id>.faiss` + `.json` (embedding model,
  dimension, chunk signature). They are rebuilt from `document_chunks` whenever the signature changes.

Planned tables (memories, artifacts, models, agent runs, evaluations, research
runs) are listed in `docs/02-architecture.md` §5 and arrive with their milestones.
