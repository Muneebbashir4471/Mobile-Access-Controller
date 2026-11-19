import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import require_admin
from ..models import AuditLog, ControlSession, Device, User, aware

router = APIRouter(prefix="/api", tags=["history"])


def _iso(dt: datetime | None) -> str | None:
    return aware(dt).isoformat() if dt else None


@router.get("/sessions")
async def list_sessions(
    device_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = Query(200, ge=1, le=1000),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    q = (
        select(ControlSession, Device.name, User.email)
        .join(Device, Device.id == ControlSession.device_id)
        .join(User, User.id == ControlSession.user_id)
        .order_by(ControlSession.started_at.desc())
        .limit(limit)
    )
    if admin.role != "superuser":
        q = q.where(User.role != "superuser")
    if device_id:
        q = q.where(ControlSession.device_id == device_id)
    if user_id:
        q = q.where(ControlSession.user_id == user_id)
    if since:
        q = q.where(ControlSession.started_at >= since)
    if until:
        q = q.where(ControlSession.started_at < until)
    return [
        {"id": str(s.id), "device_id": str(s.device_id), "device_name": name, "user_id": str(s.user_id),
         "user_email": email, "started_at": _iso(s.started_at), "ended_at": _iso(s.ended_at),
         "end_reason": s.end_reason}
        for s, name, email in (await db.execute(q)).all()
    ]


@router.get("/audit")
async def list_audit(
    action: str | None = None,
    user_id: uuid.UUID | None = None,
    since: datetime | None = None,
    limit: int = Query(200, ge=1, le=1000),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    q = (
        select(AuditLog, User.email)
        .outerjoin(User, User.id == AuditLog.user_id)
        .order_by(AuditLog.id.desc())
        .limit(limit)
    )
    if admin.role != "superuser":
        q = q.where((User.role.is_(None)) | (User.role != "superuser"))
    if action:
        q = q.where(AuditLog.action == action)
    if user_id:
        q = q.where(AuditLog.user_id == user_id)
    if since:
        q = q.where(AuditLog.at >= since)
    return [
        {"id": a.id, "at": _iso(a.at), "user_id": str(a.user_id) if a.user_id else None, "user_email": email,
         "action": a.action, "target": a.target, "detail": a.detail}
        for a, email in (await db.execute(q)).all()
    ]
