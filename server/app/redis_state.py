"""Redis client plus the key names for live state (presence, locks, sessions, auth)."""

from redis.asyncio import Redis

_redis: Redis | None = None


def init_redis(url: str) -> Redis:
    global _redis
    if url.startswith("fake://"):
        import fakeredis

        _redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    else:
        _redis = Redis.from_url(url, decode_responses=True)
    return _redis


def get_redis() -> Redis:
    assert _redis is not None, "redis not initialised"
    return _redis


async def close_redis() -> None:
    if _redis is not None:
        await _redis.aclose()


# Key helpers -----------------------------------------------------------------

def k_lock(device_id: str) -> str:            # value: user id, TTL = lock_ttl_seconds
    return f"lock:device:{device_id}"


def k_presence(device_id: str) -> str:        # value: agent connection id, TTL = presence_ttl
    return f"presence:{device_id}"


def k_active_session(device_id: str) -> str:  # hash: session_id, user_id, user_email
    return f"active_session:{device_id}"


def k_session(session_id: str) -> str:        # hash: device_id, user_id, conn_id
    return f"session:{session_id}"


def k_auth(token_hash: str) -> str:           # hash: user_id, max_exp; TTL = idle timeout
    return f"auth:{token_hash}"


def k_login_fail(email: str) -> str:
    return f"loginfail:{email.lower()}"


def k_alert(kind: str, device_id: str) -> str:
    return f"alerted:{kind}:{device_id}"


def k_thumb(device_id: str) -> str:           # json {"jpeg": base64, "at": epoch}; short TTL
    return f"thumb:{device_id}"


def k_thumb_req(device_id: str) -> str:       # throttles thumbnail requests sent to the phone
    return f"thumbreq:{device_id}"


async def rate_limit(key: str, limit: int, window_seconds: int) -> bool:
    """Fixed-window counter. Returns True while under the limit."""
    r = get_redis()
    full = f"rl:{key}"
    count = await r.incr(full)
    if count == 1:
        await r.expire(full, window_seconds)
    return count <= limit
