"""wss://<host>/ws/agent — one connection per phone, authenticated by the device token."""

import asyncio
import json
import logging
import time
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from ..config import get_settings
from ..db import session_factory
from ..deps import client_ip
from ..models import Device, utcnow
from ..redis_state import get_redis, k_presence, k_session, k_thumb
from ..security import hash_token
from . import alerts
from .bus import bus
from .devices import broadcast_device, effective_video
from .sessions import end_device_session, end_session

log = logging.getLogger(__name__)
router = APIRouter()

MAX_THUMB_B64 = 200_000  # a 270 px wide JPEG is ~15 KB; anything far bigger is ignored

STATUS_FIELDS = (
    "battery", "charging", "signal", "carrier", "network_type", "capture_ready", "input_ready",
    "capture_mode",  # "projection" | "fallback" | "none"
    "screen_on", "locked",
)
# "notice": short messages from the phone for the operator (e.g. the result of an unlock).
FORWARD_TO_OPERATOR = {
    "rtc_answer": ("sdp",), "ice": ("candidate",), "notice": ("message",),
    "rtc_stats": ("stats",),  # the phone's encoder / send-queue stats for the control view
}


class AgentConn:
    def __init__(self, ws: WebSocket, device_id: str, ip: str) -> None:
        self.ws = ws
        self.device_id = device_id
        self.ip = ip
        self.conn_id = uuid.uuid4().hex

    async def deliver(self, msg: dict) -> None:
        if msg.get("type") == "_kick":
            if msg.get("except") != self.conn_id:
                await self.ws.close(code=4409, reason="replaced")
            return
        if msg.get("type") == "_revoked":
            await self.ws.close(code=4401, reason="revoked")
            return
        await self.ws.send_json(msg)


def _bearer(ws: WebSocket) -> str | None:
    auth = ws.headers.get("authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else None


async def _touch_presence(conn: AgentConn) -> None:
    await get_redis().set(k_presence(conn.device_id), conn.conn_id, ex=get_settings().presence_ttl_seconds)


@router.websocket("/ws/agent")
async def agent_ws(ws: WebSocket) -> None:
    token = _bearer(ws)
    device = None
    if token:
        async with session_factory()() as db:
            device = await db.scalar(
                select(Device).where(Device.token_hash == hash_token(token), Device.revoked_at.is_(None))
            )
    if device is None:
        await ws.close(code=4401)
        return

    await ws.accept()
    conn = AgentConn(ws, str(device.id), client_ip(ws))
    await bus.register_agent(conn.device_id, conn)
    await bus.to_agent(conn.device_id, {"type": "_kick", "except": conn.conn_id})  # other workers
    log.info("agent %s connected from %s", conn.device_id, conn.ip)

    try:
        await _touch_presence(conn)
        async with session_factory()() as db:
            d = await db.get(Device, device.id)
            d.last_seen_at = utcnow()
            await db.commit()
            await broadcast_device(d)
        await ws.send_json(_config_message(device))

        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if isinstance(msg, dict):
                await _handle(conn, msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("agent %s connection error", conn.device_id)
    finally:
        bus.unregister_agent(conn.device_id, conn)
        # Shielded so a cancelled handler still marks the phone offline.
        await asyncio.shield(_cleanup(conn))
        log.info("agent %s disconnected", conn.device_id)


async def _cleanup(conn: AgentConn) -> None:
    r = get_redis()
    if await r.get(k_presence(conn.device_id)) != conn.conn_id:
        return  # a newer connection already owns this phone
    await r.delete(k_presence(conn.device_id))
    await end_device_session(conn.device_id, "device_lost", detail="agent disconnected")
    async with session_factory()() as db:
        d = await db.get(Device, uuid.UUID(conn.device_id))
        if d is not None:
            await broadcast_device(d)


def _config_message(device: Device) -> dict:
    return {
        "type": "config",
        "video": effective_video(device),
        "heartbeat_seconds": get_settings().heartbeat_seconds,
    }


async def _handle(conn: AgentConn, msg: dict) -> None:
    kind = msg.get("type")

    if kind in ("hello", "status"):
        await _touch_presence(conn)
        async with session_factory()() as db:
            d = await db.get(Device, uuid.UUID(conn.device_id))
            if d is None:
                return
            d.last_seen_at = utcnow()
            if kind == "hello":
                for field in ("model", "android_version", "app_version"):
                    if msg.get(field) is not None:
                        setattr(d, field, str(msg[field])[:100])
            else:
                status = {f: msg.get(f) for f in STATUS_FIELDS}
                status["ip"] = conn.ip
                status["received_at"] = d.last_seen_at.isoformat()
                d.last_status = status
                if not d.sim_carrier and status.get("carrier"):
                    d.sim_carrier = str(status["carrier"])[:100]
            await db.commit()
            await broadcast_device(d)
            if kind == "status":
                await alerts.check_status(d, d.last_status)
        return

    if kind == "thumb":
        # A small JPEG of the screen for the Phones page, sent when the hub asks for one.
        jpeg = msg.get("jpeg")
        if isinstance(jpeg, str) and 0 < len(jpeg) <= MAX_THUMB_B64:
            await get_redis().set(
                k_thumb(conn.device_id), json.dumps({"jpeg": jpeg, "at": time.time()}), ex=300
            )
        return

    session_id = str(msg.get("session_id", ""))
    if not session_id:
        return
    sess = await get_redis().hgetall(k_session(session_id))
    if not sess or sess["device_id"] != conn.device_id:
        return

    if kind in FORWARD_TO_OPERATOR:
        out = {"type": kind, "session_id": session_id, "device_id": conn.device_id}
        for field in FORWARD_TO_OPERATOR[kind]:
            out[field] = msg.get(field)
        await bus.to_user(sess["user_id"], out)
    elif kind == "session_ended":
        await end_session(session_id, "device_lost", detail=str(msg.get("reason", ""))[:200])
