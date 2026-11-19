"""Control sessions and the one-controller-per-phone lock.

The lock is the Redis key lock:device:{id} holding the user id, with a lock_ttl_seconds
expiry refreshed by operator activity. When it lapses the sweeper ends the session.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import session_factory
from ..models import ControlSession, Device, User, utcnow
from ..redis_state import get_redis, k_active_session, k_lock, k_presence, k_session
from ..security import turn_credentials
from .bus import bus
from .devices import effective_video


def _lock_view(sid: str, user: User, started_at: str) -> dict:
    return {"session_id": sid, "user_id": str(user.id), "user_email": user.public_label, "started_at": started_at}


async def open_session(db: AsyncSession, user: User, device: Device, conn_id: str) -> dict:
    """Returns an `opened` or `denied` message for the operator."""
    s = get_settings()
    r = get_redis()
    did, uid = str(device.id), str(user.id)

    if not await r.exists(k_presence(did)):
        return {"type": "denied", "device_id": did, "reason": "offline"}

    got = await r.set(k_lock(did), uid, nx=True, ex=s.lock_ttl_seconds)
    if not got and await r.get(k_lock(did)) == uid:
        # Same user opening again (new tab or reload): replace the old session.
        active = await r.hgetall(k_active_session(did))
        if active:
            await end_session(active["session_id"], "closed")
        await r.delete(k_lock(did))
        got = await r.set(k_lock(did), uid, nx=True, ex=s.lock_ttl_seconds)
    if not got:
        active = await r.hgetall(k_active_session(did))
        return {
            "type": "denied",
            "device_id": did,
            "reason": "locked",
            "held_by": active.get("user_email") if active else None,
        }

    row = ControlSession(device_id=device.id, user_id=user.id)
    db.add(row)
    await db.commit()
    sid = str(row.id)
    started = datetime.now(timezone.utc).isoformat()

    await r.hset(k_session(sid), mapping={"device_id": did, "user_id": uid, "conn_id": conn_id})
    await r.hset(
        k_active_session(did),
        mapping={"session_id": sid, "user_id": uid, "user_email": user.public_label, "started_at": started},
    )

    await bus.to_agent(
        did,
        {"type": "session_start", "session_id": sid, "turn": turn_credentials(sid), "video": effective_video(device)},
    )
    await bus.broadcast({"type": "lock_update", "device_id": did, "lock": _lock_view(sid, user, started)})
    return {
        "type": "opened",
        "device_id": did,
        "session_id": sid,
        "turn": turn_credentials(sid),
        "lock_ttl": s.lock_ttl_seconds,
    }


async def end_session(session_id: str, reason: str, *, by: str | None = None, detail: str | None = None) -> bool:
    """Ends a session once; later calls for the same id are no-ops."""
    r = get_redis()
    data = await r.hgetall(k_session(session_id))
    if not data or not await r.delete(k_session(session_id)):
        return False
    did, uid = data["device_id"], data["user_id"]

    if await r.hget(k_active_session(did), "session_id") == session_id:
        await r.delete(k_active_session(did))
        if await r.get(k_lock(did)) == uid:
            await r.delete(k_lock(did))

    async with session_factory()() as db:
        row = await db.get(ControlSession, uuid.UUID(session_id))
        if row is not None and row.ended_at is None:
            row.ended_at = utcnow()
            row.end_reason = reason
            await db.commit()

    await bus.to_agent(did, {"type": "session_stop", "session_id": session_id})
    await bus.to_user(
        uid,
        {"type": "session_ended", "session_id": session_id, "device_id": did, "reason": reason, "by": by, "detail": detail},
    )
    await bus.broadcast({"type": "lock_update", "device_id": did, "lock": None})
    return True


async def owned_session(session_id: str, user_id: str, conn_id: str | None = None) -> dict | None:
    data = await get_redis().hgetall(k_session(str(session_id)))
    if not data or data["user_id"] != user_id:
        return None
    if conn_id is not None and data["conn_id"] != conn_id:
        return None
    return data


async def refresh_lock(session_id: str, user_id: str) -> int | None:
    data = await owned_session(session_id, user_id)
    if not data:
        return None
    r = get_redis()
    ttl = get_settings().lock_ttl_seconds
    if await r.get(k_lock(data["device_id"])) != user_id:
        return None
    await r.expire(k_lock(data["device_id"]), ttl)
    return ttl


async def end_device_session(device_id: str, reason: str, detail: str | None = None) -> None:
    sid = await get_redis().hget(k_active_session(device_id), "session_id")
    if sid:
        await end_session(sid, reason, detail=detail)


async def sweep_expired_locks() -> None:
    r = get_redis()
    async for key in r.scan_iter(match="active_session:*"):
        did = key.split(":", 1)[1]
        if not await r.exists(k_lock(did)):
            sid = await r.hget(key, "session_id")
            if sid:
                await end_session(sid, "timeout")
            else:
                await r.delete(key)
