"""The network gate: every feature that reaches the internet (model and image downloads) asks here first.

Network access is off by default and only the user can turn it on (Settings). Each allowed request is
written to the audit log with its purpose and destination, so internet use is visible after the fact.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from services.audit import service as audit
from services.settings import service as settings_service


class NetworkDisabled(Exception):
    def __init__(self, purpose: str) -> None:
        super().__init__(
            f"{purpose} needs internet access, which is turned off. Turn on network access in Settings first."
        )
        self.message = str(self)


async def require(db: AsyncSession, purpose: str, *, destination: str, client_ip: str | None = None) -> None:
    """Raise NetworkDisabled unless the user enabled network access; otherwise audit the request.

    The caller commits (so the audit entry is saved even if the download then fails)."""
    if not (await settings_service.load(db)).network_access_enabled:
        raise NetworkDisabled(purpose)
    await audit.record(
        db, "network.request", details={"purpose": purpose, "destination": destination}, client_ip=client_ip
    )
