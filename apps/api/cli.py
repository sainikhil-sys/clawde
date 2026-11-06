"""`clawde-api` command: serve the API or manage database migrations."""

from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from storage.database import migrate

from .config import get_settings

REPO_ROOT = Path(__file__).resolve().parents[2]


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="clawde-api")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="Run the API server")
    serve.add_argument("--reload", action="store_true", help="Restart on code changes (development)")

    up = sub.add_parser("migrate", help="Apply database migrations")
    up.add_argument("--revision", default="head")

    down = sub.add_parser("downgrade", help="Revert database migrations")
    down.add_argument("revision", help="Target revision, e.g. -1 or base")

    sub.add_parser("info", help="Show resolved configuration")

    args = parser.parse_args(argv)
    settings = get_settings()

    if args.command == "serve":
        uvicorn.run(
            "api.main:app_factory",
            factory=True,
            host=settings.host,
            port=settings.port,
            reload=args.reload,
            reload_dirs=[str(REPO_ROOT / d) for d in ("apps/api", "core", "models", "services", "storage")]
            if args.reload
            else None,
            log_config=None,  # structlog configures logging in the app lifespan
            server_header=False,
        )
    elif args.command == "migrate":
        migrate.upgrade(settings.resolved_database_url, args.revision)
        print(f"Database at revision {args.revision}.")
    elif args.command == "downgrade":
        migrate.downgrade(settings.resolved_database_url, args.revision)
        print(f"Database downgraded to {args.revision}.")
    elif args.command == "info":
        print(f"data_dir      {settings.data_dir}")
        print(f"database_url  {settings.resolved_database_url}")
        print(f"listen        http://{settings.host}:{settings.port}")
        print(f"origins       {', '.join(settings.allowed_origins)}")


if __name__ == "__main__":
    main()
