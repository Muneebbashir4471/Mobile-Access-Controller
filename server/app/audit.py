import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from .models import AuditLog


def audit(
    db: AsyncSession,
    action: str,
    user_id: uuid.UUID | None = None,
    target: str | None = None,
    detail: dict | None = None,
) -> None:
    """Adds an audit row to the current transaction. The caller commits."""
    db.add(AuditLog(user_id=user_id, action=action, target=target, detail=detail))
