"""Routes hub messages between processes through Redis pub/sub.

Channels:
  hub:agent:<device_id>   messages for one phone's agent connection
  hub:user:<user_id>      messages for every dashboard connection of one user
  hub:agents              messages for every connected agent (update_available)
  hub:operators           broadcasts (device_update, lock_update, alert); filtered per user

Every process subscribes to hub:* and delivers to the connections it holds locally, so the
api can run with several workers.
"""

import asyncio
import json
import logging
from typing import Protocol

from ..redis_state import get_redis

log = logging.getLogger(__name__)


class Conn(Protocol):
    conn_id: str

    async def deliver(self, msg: dict) -> None: ...


class Bus:
    def __init__(self) -> None:
        self.agents: dict[str, Conn] = {}
        self.operators: dict[str, set[Conn]] = {}
        self._task: asyncio.Task | None = None
        self._ready = asyncio.Event()

    # Local registry ---------------------------------------------------------

    async def register_agent(self, device_id: str, conn: Conn) -> None:
        old = self.agents.get(device_id)
        self.agents[device_id] = conn
        if old is not None and old is not conn:
            await old.deliver({"type": "_kick", "except": conn.conn_id})

    def unregister_agent(self, device_id: str, conn: Conn) -> None:
        if self.agents.get(device_id) is conn:
            del self.agents[device_id]

    def register_operator(self, user_id: str, conn: Conn) -> None:
        self.operators.setdefault(user_id, set()).add(conn)

    def unregister_operator(self, user_id: str, conn: Conn) -> None:
        conns = self.operators.get(user_id)
        if conns:
            conns.discard(conn)
            if not conns:
                del self.operators[user_id]

    # Publishing -------------------------------------------------------------

    async def _publish(self, channel: str, msg: dict) -> None:
        await get_redis().publish(channel, json.dumps(msg, default=str))

    async def to_agent(self, device_id: str, msg: dict) -> None:
        await self._publish(f"hub:agent:{device_id}", msg)

    async def to_user(self, user_id: str, msg: dict) -> None:
        await self._publish(f"hub:user:{user_id}", msg)

    async def to_all_agents(self, msg: dict) -> None:
        await self._publish("hub:agents", msg)

    async def broadcast(self, msg: dict) -> None:
        """msg must carry a top-level device_id so each connection can filter it."""
        await self._publish("hub:operators", msg)

    # Subscriber -------------------------------------------------------------

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="hub-bus")
        await asyncio.wait_for(self._ready.wait(), timeout=10)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    async def _run(self) -> None:
        while True:
            pubsub = get_redis().pubsub()
            try:
                await pubsub.psubscribe("hub:*")
                self._ready.set()
                while True:
                    m = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                    if m is None:
                        continue
                    try:
                        await self._dispatch(m["channel"], json.loads(m["data"]))
                    except Exception:
                        log.exception("dispatch failed on %s", m.get("channel"))
            except asyncio.CancelledError:
                await pubsub.aclose()
                raise
            except Exception:
                log.exception("bus subscriber error; reconnecting")
                await pubsub.aclose()
                await asyncio.sleep(1)

    async def _dispatch(self, channel: str, msg: dict) -> None:
        _, kind, *rest = channel.split(":", 2)
        if kind == "agents":
            targets = list(self.agents.values())
        elif kind == "agent":
            conn = self.agents.get(rest[0])
            targets = [conn] if conn else []
        elif kind == "user":
            targets = list(self.operators.get(rest[0], ()))
        elif kind == "operators":
            targets = [c for conns in self.operators.values() for c in conns]
        else:
            return
        for conn in targets:
            try:
                await conn.deliver(msg)
            except Exception:
                log.debug("deliver failed", exc_info=True)


bus = Bus()
