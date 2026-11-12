import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import get_settings
from .db import dispose_engine, init_engine
from .hub import agent_ws, operator_ws
from .hub.background import sweeper_loop
from .hub.bus import bus
from .redis_state import close_redis, init_redis
from .routers import agent_updates, auth, devices, history, users

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    init_engine(s.database_url)
    init_redis(s.redis_url)
    await bus.start()
    sweeper = asyncio.create_task(sweeper_loop(), name="sweeper")
    try:
        yield
    finally:
        sweeper.cancel()
        await bus.stop()
        await close_redis()
        await dispose_engine()


def create_app() -> FastAPI:
    app = FastAPI(title="MT5 Phone Control", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    for r in (agent_updates.router, auth.router, devices.router, users.router, history.router, agent_ws.router, operator_ws.router):
        app.include_router(r)

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    return app


app = create_app()
