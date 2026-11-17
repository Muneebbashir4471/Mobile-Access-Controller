"""Phone alerts: offline for more than 3 minutes, no data connection, battery under 20%, stuck in
the 1 fps capture fallback.

Each alert fires once and re-arms when the condition clears.
"""

import asyncio
import logging
import time
from datetime import timedelta

import httpx
from sqlalchemy import select

from ..config import get_settings
from ..db import session_factory
from ..models import Device, aware, utcnow
from ..redis_state import get_redis, k_alert, k_presence
from .bus import bus

log = logging.getLogger("alerts")
_pending: set[asyncio.Task] = set()


async def _send_telegram(text: str) -> None:
    s = get_settings()
    if not (s.telegram_bot_token and s.telegram_chat_id):
        return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"https://api.telegram.org/bot{s.telegram_bot_token}/sendMessage",
                json={"chat_id": s.telegram_chat_id, "text": text},
            )
    except Exception:
        log.exception("telegram send failed")


async def raise_alert(kind: str, device: Device, message: str) -> None:
    if not await get_redis().set(k_alert(kind, str(device.id)), "1", nx=True):
        return
    text = f"[{device.name}] {message}"
    log.warning("ALERT %s", text)
    task = asyncio.create_task(_send_telegram(text))
    _pending.add(task)
    task.add_done_callback(_pending.discard)
    await bus.broadcast({"type": "alert", "device_id": str(device.id), "kind": kind, "message": text})


async def clear_alert(kind: str, device_id: str) -> None:
    await get_redis().delete(k_alert(kind, device_id))


async def check_status(device: Device, status: dict) -> None:
    s = get_settings()
    did = str(device.id)
    battery = status.get("battery")
    if isinstance(battery, (int, float)):
        if battery < s.low_battery_percent:
            await raise_alert("battery", device, f"battery at {battery}%")
        elif battery >= s.low_battery_percent + 5:
            await clear_alert("battery", did)
    if status.get("network_type") == "none":
        await raise_alert("no_data", device, "no mobile data connection")
    else:
        await clear_alert("no_data", did)
    await _check_fallback(device, status.get("capture_mode"))


async def _check_fallback(device: Device, mode: object) -> None:
    """Alerts once a phone has been stuck in the 1 fps fallback for fallback_alert_seconds. A
    short fallback while the app restarts and re-asks for capture permission is normal."""
    s = get_settings()
    r = get_redis()
    did = str(device.id)
    key = f"fallback_since:{did}"
    if mode != "fallback":
        await r.delete(key)
        await clear_alert("fallback", did)
        return
    now = int(time.time())
    await r.set(key, now, nx=True, ex=7 * 86400)
    since = int(await r.get(key) or now)
    if now - since >= s.fallback_alert_seconds:
        await raise_alert(
            "fallback", device,
            f"stuck at 1 fps for {(now - since) // 60} minutes: screen capture permission was lost. "
            "Open the agent app on the phone and tap Fix.",
        )


async def sweep_offline() -> None:
    s = get_settings()
    r = get_redis()
    cutoff = utcnow() - timedelta(seconds=s.offline_alert_seconds)
    async with session_factory()() as db:
        devices = (await db.scalars(select(Device).where(Device.revoked_at.is_(None)))).all()
    for d in devices:
        did = str(d.id)
        if await r.exists(k_presence(did)):
            await clear_alert("offline", did)
        elif d.last_seen_at is not None and aware(d.last_seen_at) < cutoff:
            await raise_alert("offline", d, f"offline for more than {s.offline_alert_seconds // 60} minutes")
