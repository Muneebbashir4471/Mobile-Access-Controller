import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..deps import client_ip, current_user, require_admin, visible_device_ids
from ..hub.bus import bus
from ..hub.devices import broadcast_device, device_snapshot, effective_video
from ..hub.sessions import end_device_session
from ..models import Device, Mt5Account, PairingCode, User, aware, utcnow
from ..redis_state import rate_limit
from ..security import hash_token, new_pairing_code, new_token, normalize_pairing_code

router = APIRouter(prefix="/api", tags=["devices"])


async def _get_device(db: AsyncSession, device_id: uuid.UUID) -> Device:
    d = await db.get(Device, device_id)
    if d is None or d.revoked_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such device")
    return d


@router.get("/devices")
async def list_devices(user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    q = select(Device).where(Device.revoked_at.is_(None)).order_by(Device.name)
    visible = await visible_device_ids(db, user)
    if visible is not None:
        q = q.where(Device.id.in_(visible))
    return [await device_snapshot(d) for d in (await db.scalars(q)).all()]


# Pairing ---------------------------------------------------------------------

@router.post("/devices/pairing-codes")
async def create_pairing_code(admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    s = get_settings()
    code = new_pairing_code()
    expires = utcnow() + timedelta(seconds=s.pairing_code_ttl_seconds)
    db.add(PairingCode(code_hash=hash_token(code), created_by=admin.id, expires_at=expires))
    audit(db, "pairing_code_created", admin.id, None, {"expires_at": expires.isoformat()})
    await db.commit()
    return {
        "code": code,
        "expires_at": expires.isoformat(),
        # Encoded into the QR the agent scans.
        "qr_payload": {"server": s.public_url, "code": code},
    }


class PairIn(BaseModel):
    code: str
    model: str | None = None
    android_version: str | None = None
    app_version: str | None = None


@router.post("/devices/pair")
async def pair(body: PairIn, request: Request, db: AsyncSession = Depends(get_db)):
    ip = client_ip(request)
    if not await rate_limit(f"pair:{ip}", get_settings().pairing_rate_per_minute, 60):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts, wait a minute")

    pc = await db.get(PairingCode, hash_token(normalize_pairing_code(body.code)), with_for_update=True)
    now = utcnow()
    if pc is None or pc.used_at is not None or aware(pc.expires_at) < now:
        audit(db, "pairing_failed", None, None, {"ip": ip})
        await db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid or expired pairing code")

    pc.used_at = now
    token = new_token()
    device = Device(
        id=uuid.uuid4(),
        token_hash=hash_token(token),
        model=(body.model or "")[:100] or None,
        android_version=(body.android_version or "")[:20] or None,
        app_version=(body.app_version or "")[:20] or None,
    )
    device.name = f"{body.model or 'Phone'} {str(device.id)[:4]}"[:100]
    db.add(device)
    audit(db, "device_paired", pc.created_by, str(device.id), {"ip": ip, "model": body.model})
    await db.commit()
    return {"device_id": str(device.id), "token": token, "name": device.name}


# Device admin ----------------------------------------------------------------

class VideoSettings(BaseModel):
    width: int | None = Field(None, ge=240, le=1440)
    fps: int | None = Field(None, ge=1, le=30)
    bitrate: int | None = Field(None, ge=100_000, le=4_000_000)


class DevicePatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    notes: str | None = None
    sim_carrier: str | None = Field(None, max_length=100)
    video_settings: VideoSettings | None = None


@router.patch("/devices/{device_id}")
async def update_device(device_id: uuid.UUID, body: DevicePatch, admin: User = Depends(require_admin),
                        db: AsyncSession = Depends(get_db)):
    d = await _get_device(db, device_id)
    changes = body.model_dump(exclude_unset=True)
    for field in ("name", "notes", "sim_carrier"):
        if field in changes:
            setattr(d, field, changes[field])
    if body.video_settings is not None:
        d.video_settings = {**(d.video_settings or {}),
                            **body.video_settings.model_dump(exclude_none=True)}
    audit(db, "device_updated", admin.id, str(d.id), changes)
    await db.commit()
    if body.video_settings is not None:
        await bus.to_agent(str(d.id), {"type": "config", "video": effective_video(d),
                                       "heartbeat_seconds": get_settings().heartbeat_seconds})
    await broadcast_device(d)
    return await device_snapshot(d)


@router.delete("/devices/{device_id}")
async def revoke_device(device_id: uuid.UUID, admin: User = Depends(require_admin),
                        db: AsyncSession = Depends(get_db)):
    d = await _get_device(db, device_id)
    d.revoked_at = utcnow()
    audit(db, "device_revoked", admin.id, str(d.id), {"name": d.name})
    await db.commit()
    await end_device_session(str(d.id), "device_lost", detail="device revoked")
    await bus.to_agent(str(d.id), {"type": "_revoked"})
    await bus.broadcast({"type": "device_removed", "device_id": str(d.id)})
    return {"ok": True}


# MT5 account directory -------------------------------------------------------

class AccountIn(BaseModel):
    login: str = Field(min_length=1, max_length=32)
    broker_server: str = Field(min_length=1, max_length=100)
    label: str | None = Field(None, max_length=100)
    notes: str | None = None


class AccountPatch(BaseModel):
    login: str | None = Field(None, min_length=1, max_length=32)
    broker_server: str | None = Field(None, min_length=1, max_length=100)
    label: str | None = Field(None, max_length=100)
    notes: str | None = None
    device_id: uuid.UUID | None = None


def account_out(a: Mt5Account, device: Device | None = None) -> dict:
    out = {"id": str(a.id), "device_id": str(a.device_id), "login": a.login,
           "broker_server": a.broker_server, "label": a.label, "notes": a.notes}
    if device is not None:
        out["device_name"] = device.name
    return out


@router.get("/devices/{device_id}/accounts")
async def list_accounts(device_id: uuid.UUID, admin: User = Depends(require_admin),
                        db: AsyncSession = Depends(get_db)):
    await _get_device(db, device_id)
    rows = await db.scalars(select(Mt5Account).where(Mt5Account.device_id == device_id).order_by(Mt5Account.login))
    return [account_out(a) for a in rows]


@router.post("/devices/{device_id}/accounts", status_code=201)
async def add_account(device_id: uuid.UUID, body: AccountIn, admin: User = Depends(require_admin),
                      db: AsyncSession = Depends(get_db)):
    await _get_device(db, device_id)
    a = Mt5Account(device_id=device_id, **body.model_dump())
    db.add(a)
    audit(db, "account_added", admin.id, str(device_id), {"login": body.login})
    await db.commit()
    return account_out(a)


@router.patch("/accounts/{account_id}")
async def update_account(account_id: uuid.UUID, body: AccountPatch, admin: User = Depends(require_admin),
                         db: AsyncSession = Depends(get_db)):
    a = await db.get(Mt5Account, account_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such account")
    changes = body.model_dump(exclude_unset=True)
    if "device_id" in changes:
        await _get_device(db, changes["device_id"])
    for k, v in changes.items():
        setattr(a, k, v)
    audit(db, "account_updated", admin.id, str(a.id), {k: str(v) for k, v in changes.items()})
    await db.commit()
    return account_out(a)


@router.delete("/accounts/{account_id}")
async def delete_account(account_id: uuid.UUID, admin: User = Depends(require_admin),
                         db: AsyncSession = Depends(get_db)):
    a = await db.get(Mt5Account, account_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such account")
    audit(db, "account_deleted", admin.id, str(a.device_id), {"login": a.login})
    await db.delete(a)
    await db.commit()
    return {"ok": True}


@router.get("/accounts")
async def search_accounts(q: str = "", user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """Search by login or label. Operators only see accounts on their assigned phones."""
    stmt = (
        select(Mt5Account, Device)
        .join(Device, Device.id == Mt5Account.device_id)
        .where(Device.revoked_at.is_(None))
        .order_by(Mt5Account.login)
        .limit(100)
    )
    term = q.strip()
    if term:
        like = f"%{term}%"
        stmt = stmt.where(or_(Mt5Account.login.like(f"{term}%"), Mt5Account.label.ilike(like)))
    visible = await visible_device_ids(db, user)
    if visible is not None:
        stmt = stmt.where(Device.id.in_(visible))
    return [account_out(a, d) for a, d in (await db.execute(stmt)).all()]
