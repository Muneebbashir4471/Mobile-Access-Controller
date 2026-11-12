from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def init_engine(url: str) -> AsyncEngine:
    global _engine, _sessionmaker
    kwargs = {} if url.startswith("sqlite") else {"pool_pre_ping": True}
    _engine = create_async_engine(url, **kwargs)
    _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


async def dispose_engine() -> None:
    if _engine is not None:
        await _engine.dispose()


def session_factory() -> async_sessionmaker[AsyncSession]:
    assert _sessionmaker is not None, "database not initialised"
    return _sessionmaker


async def get_db() -> AsyncIterator[AsyncSession]:
    async with session_factory()() as session:
        yield session
