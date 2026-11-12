import uuid

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth_sessions import COOKIE_NAME, resolve_session
from .db import get_db
from .models import Assignment, User


async def load_active_user(db: AsyncSession, user_id: uuid.UUID | None) -> User | None:
    if user_id is None:
        return None
    user = await db.get(User, user_id)
    if user is None or not user.active:
        return None
    return user


async def current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    user_id = await resolve_session(request.cookies.get(COOKIE_NAME))
    user = await load_active_user(db, user_id)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    return user


async def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin only")
    return user


async def visible_device_ids(db: AsyncSession, user: User) -> set[uuid.UUID] | None:
    """None means every device (admins)."""
    if user.role == "admin":
        return None
    rows = await db.scalars(select(Assignment.device_id).where(Assignment.user_id == user.id))
    return set(rows)


def client_ip(request) -> str:
    # Caddy sets X-Forwarded-For; it is the only thing in front of the api container.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
