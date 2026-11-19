import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..db import get_db
from ..deps import require_admin
from ..hub.bus import bus
from ..models import Assignment, Device, User
from ..security import hash_password

router = APIRouter(prefix="/api/users", tags=["users"])


class UserIn(BaseModel):
    email: str = Field(min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+$")
    password: str = Field(min_length=12, max_length=200)
    role: str = Field(pattern="^(superuser|admin|operator)$")
    name: str | None = Field(None, max_length=100)


class UserPatch(BaseModel):
    name: str | None = Field(None, max_length=100)
    role: str | None = Field(None, pattern="^(superuser|admin|operator)$")
    active: bool | None = None
    password: str | None = Field(None, min_length=12, max_length=200)


def _can_manage(caller: User, target_role: str) -> None:
    """A superuser may manage any account and grant any role; an admin may manage operators and
    other admins (create, set password, disable) but never superusers. Raises 403 otherwise.
    `target_role` is the role being acted on or granted. Admins see every phone automatically."""
    if caller.role == "superuser":
        return
    if target_role == "superuser":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only a superuser can manage superuser accounts")


class AssignIn(BaseModel):
    device_ids: list[uuid.UUID]


async def _user_out(db: AsyncSession, u: User) -> dict:
    ids = await db.scalars(select(Assignment.device_id).where(Assignment.user_id == u.id))
    return {"id": str(u.id), "email": u.email, "name": u.name, "role": u.role, "active": u.active,
            "totp_enabled": u.totp_enabled, "created_at": u.created_at.isoformat() if u.created_at else None,
            "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
            "device_ids": [str(i) for i in ids]}


async def _get_user(db: AsyncSession, user_id: uuid.UUID) -> User:
    u = await db.get(User, user_id)
    if u is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such user")
    return u


@router.get("")
async def list_users(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    users = (await db.scalars(select(User).order_by(User.email))).all()
    return [await _user_out(db, u) for u in users]


@router.post("", status_code=201)
async def create_user(body: UserIn, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    _can_manage(admin, body.role)  # only a superuser may create superuser accounts
    email = body.email.strip().lower()
    if await db.scalar(select(User).where(func.lower(User.email) == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already in use")
    u = User(email=email, password_hash=hash_password(body.password), role=body.role, totp_enabled=False,
             name=(body.name or "").strip() or None)
    db.add(u)
    audit(db, "user_created", admin.id, email, {"role": body.role})
    await db.commit()
    return await _user_out(db, u)


@router.patch("/{user_id}")
async def update_user(user_id: uuid.UUID, body: UserPatch, admin: User = Depends(require_admin),
                      db: AsyncSession = Depends(get_db)):
    u = await _get_user(db, user_id)
    _can_manage(admin, u.role)  # an admin cannot touch a superuser
    if body.role is not None:
        _can_manage(admin, body.role)  # nor grant the superuser role
    if u.id == admin.id and (body.active is False or (body.role is not None and body.role != u.role)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot change your own role or disable yourself")
    changes = body.model_dump(exclude_unset=True)
    if body.role is not None:
        u.role = body.role
    if body.active is not None:
        u.active = body.active
    if "name" in changes:
        u.name = (body.name or "").strip() or None
    if body.password is not None:
        u.password_hash = hash_password(body.password)
    audit(db, "user_updated", admin.id, u.email,
          {k: ("***" if k == "password" else v) for k, v in changes.items()})
    await db.commit()
    await bus.to_user(str(u.id), {"type": "_reload"})
    return await _user_out(db, u)


@router.post("/{user_id}/reset-2fa")
async def reset_2fa(user_id: uuid.UUID, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """For a user who lost their authenticator: turns 2FA off so they can set it up again."""
    u = await _get_user(db, user_id)
    _can_manage(admin, u.role)  # an admin cannot reset a superuser's 2FA
    u.totp_secret = None
    u.totp_enabled = False
    audit(db, "user_2fa_reset", admin.id, u.email)
    await db.commit()
    return await _user_out(db, u)


@router.put("/{user_id}/devices")
async def set_assignments(user_id: uuid.UUID, body: AssignIn, admin: User = Depends(require_admin),
                          db: AsyncSession = Depends(get_db)):
    u = await _get_user(db, user_id)
    if u.role != "operator":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Admins and superusers already see every phone")
    wanted = set(body.device_ids)
    if wanted:
        found = set(await db.scalars(select(Device.id).where(Device.id.in_(wanted), Device.revoked_at.is_(None))))
        if found != wanted:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown device id")
    await db.execute(delete(Assignment).where(Assignment.user_id == u.id))
    db.add_all(Assignment(user_id=u.id, device_id=d) for d in wanted)
    audit(db, "assignments_set", admin.id, u.email, {"device_ids": sorted(str(d) for d in wanted)})
    await db.commit()
    await bus.to_user(str(u.id), {"type": "_reload"})
    return await _user_out(db, u)
