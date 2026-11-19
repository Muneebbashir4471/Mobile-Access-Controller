"""How a device looks to the dashboard, combining the database row and live Redis state."""

from ..config import get_settings
from ..models import Device, aware
from ..redis_state import get_redis, k_active_session, k_presence
from .bus import bus


def effective_video(device: Device) -> dict:
    # One server-wide setting (MT5_DEFAULT_VIDEO); old per-phone values in devices.video_settings are ignored.
    return dict(get_settings().default_video)


def device_view(device: Device, online: bool, active: dict | None) -> dict:
    last_seen = aware(device.last_seen_at)
    return {
        "id": str(device.id),
        "name": device.name,
        "model": device.model,
        "android_version": device.android_version,
        "app_version": device.app_version,
        "sim_carrier": device.sim_carrier,
        "notes": device.notes,
        "video_settings": effective_video(device),
        "online": online,
        "last_seen_at": last_seen.isoformat() if last_seen else None,
        "status": device.last_status or {},
        "lock": (
            {
                "session_id": active["session_id"],
                "user_id": active["user_id"],
                "user_email": active.get("user_email"),
                "started_at": active.get("started_at"),
            }
            if active
            else None
        ),
    }


async def device_snapshot(device: Device) -> dict:
    r = get_redis()
    did = str(device.id)
    online = bool(await r.exists(k_presence(did)))
    active = await r.hgetall(k_active_session(did))
    return device_view(device, online, active or None)


async def broadcast_device(device: Device) -> None:
    await bus.broadcast(
        {"type": "device_update", "device_id": str(device.id), "device": await device_snapshot(device)}
    )
