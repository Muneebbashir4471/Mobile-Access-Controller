import asyncio
import logging

from ..config import get_settings
from ..redis_state import get_redis
from . import alerts, sessions

log = logging.getLogger(__name__)


async def sweeper_loop() -> None:
    """Expires idle session locks and raises offline alerts. One process leads each tick."""
    interval = get_settings().sweep_interval_seconds
    while True:
        try:
            if await get_redis().set("sweeper:leader", "1", nx=True, px=int(interval * 900)):
                await sessions.sweep_expired_locks()
                await alerts.sweep_offline()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("sweeper tick failed")
        await asyncio.sleep(interval)
