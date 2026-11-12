"""wss://<host>/ws/operator — the dashboard's live channel, authenticated by the login cookie."""

import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..audit import audit
from ..auth_sessions import COOKIE_NAME, resolve_session
from ..config import get_settings
from ..db import session_factory
from ..deps import load_active_user, visible_device_ids
from ..models import Device, User
from ..redis_state import get_redis, k_active_session
from .bus import bus
from .sessions import end_session, open_session, owned_session, refresh_lock

log = logging.getLogger(__name__)
router = APIRouter()

# "input" carries a data-channel event over the WebSocket when the data channel is down.
FORWARD_TO_AGENT = {"rtc_offer": ("sdp",), "ice": ("candidate",), "input": ("event",)}


class OperatorConn:
    def __init__(self, ws: WebSocket, user: User, visible: set[uuid.UUID] | None, token: str) -> None:
        self.ws = ws
        self.user_id = str(user.id)
        self.email = user.email
        self.is_admin = user.role == "admin"
        self.visible = {str(v) for v in visible} if visible is not None else None
        self.token = token
        self.conn_id = uuid.uuid4().hex
        self.sessions: set[str] = set()

    def can_see(self, device_id: str) -> bool:
        return self.visible is None or device_id in self.visible

    async def reload(self) -> None:
        async with session_factory()() as db:
            user = await load_active_user(db, uuid.UUID(self.user_id))
            if user is None:
                await self.ws.close(code=4401, reason="signed out")
                return
            self.is_admin = user.role == "admin"
            vis = await visible_device_ids(db, user)
            self.visible = {str(v) for v in vis} if vis is not None else None

    async def deliver(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "_reload":
            await self.reload()
            return
        if kind == "_signout":
            await self.ws.close(code=4401, reason="signed out")
            return
        if kind == "session_ended":
            self.sessions.discard(msg.get("session_id"))
        elif kind in ("device_update", "lock_update", "alert"):
            if not self.can_see(msg.get("device_id", "")):
                return
        await self.ws.send_json(msg)


@router.websocket("/ws/operator")
async def operator_ws(ws: WebSocket) -> None:
    origin = ws.headers.get("origin")
    if origin and origin.rstrip("/") not in get_settings().allowed_origins:
        await ws.close(code=4403)
        return

    token = ws.cookies.get(COOKIE_NAME)
    user_id = await resolve_session(token)
    async with session_factory()() as db:
        user = await load_active_user(db, user_id)
        visible = await visible_device_ids(db, user) if user else None
    if user is None:
        await ws.close(code=4401)
        return

    await ws.accept()
    conn = OperatorConn(ws, user, visible, token)
    bus.register_operator(conn.user_id, conn)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            # Messages count as activity for the login session; stop if it has expired.
            if await resolve_session(conn.token) is None:
                await ws.send_json({"type": "signed_out"})
                await ws.close(code=4401)
                break
            reply = await _handle(conn, msg)
            if reply is not None:
                await ws.send_json(reply)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("operator %s connection error", conn.email)
    finally:
        bus.unregister_operator(conn.user_id, conn)
        # Shielded so a cancelled handler still frees the phone.
        await asyncio.shield(_cleanup(conn))


async def _cleanup(conn: OperatorConn) -> None:
    for sid in list(conn.sessions):
        await end_session(sid, "closed")


async def _load_device(device_id) -> Device | None:
    try:
        did = uuid.UUID(str(device_id))
    except ValueError:
        return None
    async with session_factory()() as db:
        d = await db.get(Device, did)
    return d if d is not None and d.revoked_at is None else None


async def _open(conn: OperatorConn, device_id) -> dict:
    device = await _load_device(device_id)
    if device is None or not conn.can_see(str(device.id)):
        return {"type": "denied", "device_id": str(device_id), "reason": "not_assigned"}
    async with session_factory()() as db:
        user = await db.get(User, uuid.UUID(conn.user_id))
        reply = await open_session(db, user, device, conn.conn_id)
    if reply["type"] == "opened":
        conn.sessions.add(reply["session_id"])
    return reply


async def _handle(conn: OperatorConn, msg: dict) -> dict | None:
    kind = msg.get("type")

    if kind == "ping":
        return {"type": "pong"}

    if kind == "open":
        return await _open(conn, msg.get("device_id"))

    if kind == "takeover":
        if not conn.is_admin:
            return {"type": "error", "message": "admin only"}
        device = await _load_device(msg.get("device_id"))
        if device is None:
            return {"type": "denied", "device_id": str(msg.get("device_id")), "reason": "not_assigned"}
        did = str(device.id)
        active = await get_redis().hgetall(k_active_session(did))
        if active and active["user_id"] != conn.user_id:
            await end_session(active["session_id"], "takeover", by=conn.email)
            async with session_factory()() as db:
                audit(db, "takeover", uuid.UUID(conn.user_id), did,
                      {"displaced_user": active.get("user_email"), "session_id": active["session_id"]})
                await db.commit()
        return await _open(conn, did)

    session_id = str(msg.get("session_id", ""))
    sess = await owned_session(session_id, conn.user_id, conn.conn_id) if session_id else None
    if sess is None:
        return {"type": "error", "message": "unknown session", "session_id": session_id or None}

    if kind in FORWARD_TO_AGENT:
        out = {"type": kind, "session_id": session_id}
        for field in FORWARD_TO_AGENT[kind]:
            out[field] = msg.get(field)
        await bus.to_agent(sess["device_id"], out)
        await refresh_lock(session_id, conn.user_id)
        return None

    if kind == "activity":
        ttl = await refresh_lock(session_id, conn.user_id)
        return {"type": "lock_refreshed", "session_id": session_id, "expires_in": ttl}

    if kind == "close":
        conn.sessions.discard(session_id)
        await end_session(session_id, "closed")
        return None

    return {"type": "error", "message": f"unknown type {kind}"}
