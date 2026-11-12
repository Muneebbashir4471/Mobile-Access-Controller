"""Login sessions: random token in an HTTP-only cookie, state in Redis.

A session ends after `session_idle_seconds` without a request, or `session_max_seconds`
after login, whichever comes first.
"""

import time
import uuid

from .config import get_settings
from .redis_state import get_redis, k_auth
from .security import hash_token, new_token

COOKIE_NAME = "mt5_session"


async def create_session(user_id: uuid.UUID) -> str:
    s = get_settings()
    token = new_token()
    key = k_auth(hash_token(token))
    r = get_redis()
    await r.hset(key, mapping={"user_id": str(user_id), "max_exp": int(time.time()) + s.session_max_seconds})
    await r.expire(key, s.session_idle_seconds)
    return token


async def resolve_session(token: str | None, touch: bool = True) -> uuid.UUID | None:
    if not token:
        return None
    r = get_redis()
    key = k_auth(hash_token(token))
    data = await r.hgetall(key)
    if not data:
        return None
    if int(data.get("max_exp", 0)) < time.time():
        await r.delete(key)
        return None
    if touch:
        await r.expire(key, get_settings().session_idle_seconds)
    return uuid.UUID(data["user_id"])


async def destroy_session(token: str | None) -> None:
    if token:
        await get_redis().delete(k_auth(hash_token(token)))
