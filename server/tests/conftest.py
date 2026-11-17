import asyncio
import uuid

import pyotp
import pytest
from fastapi.testclient import TestClient

from app import db as dbmod
from app.config import get_settings
from app.models import Base, User
from app.security import hash_password

PASSWORD = "correct horse battery"


@pytest.fixture
def settings(tmp_path, monkeypatch):
    monkeypatch.setenv("MT5_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path}/test.db")
    monkeypatch.setenv("MT5_REDIS_URL", "fake://")
    monkeypatch.setenv("MT5_PUBLIC_URL", "https://testserver")
    monkeypatch.setenv("MT5_COOKIE_SECURE", "false")
    monkeypatch.setenv("MT5_SWEEP_INTERVAL_SECONDS", "0.2")
    monkeypatch.setenv("MT5_APK_DIR", str(tmp_path / "apk"))
    get_settings.cache_clear()
    yield get_settings()
    get_settings.cache_clear()


@pytest.fixture
def client(settings):
    from app.main import create_app

    from sqlalchemy import create_engine

    sync_url = settings.database_url.replace("+aiosqlite", "")
    eng = create_engine(sync_url)
    Base.metadata.create_all(eng)
    eng.dispose()

    app = create_app()
    with TestClient(app, base_url="https://testserver") as c:
        yield c


def run(client, coro_fn, *args):
    """Run an async function inside the app's event loop."""
    return client.portal.call(coro_fn, *args)


async def _add_user(email: str, role: str, totp_enabled: bool) -> tuple[str, str]:
    secret = pyotp.random_base32()
    async with dbmod.session_factory()() as db:
        u = User(id=uuid.uuid4(), email=email, password_hash=hash_password(PASSWORD), totp_secret=secret,
                 totp_enabled=totp_enabled, role=role)
        db.add(u)
        await db.commit()
        return str(u.id), secret


def add_user(client, email, role="operator", totp_enabled=None):
    # Admins and superusers must have two-factor login on, so test admins get it by default.
    if totp_enabled is None:
        totp_enabled = role in ("admin", "superuser")
    return run(client, _add_user, email, role, totp_enabled)


def login(client, email, secret):
    r = client.post("/api/auth/login", json={"email": email, "password": PASSWORD, "code": pyotp.TOTP(secret).now()})
    assert r.status_code == 200, r.text
    return r


def pair_device(client, model="Pixel 7"):
    code = client.post("/api/devices/pairing-codes").json()["code"]
    r = client.post("/api/devices/pair", json={"code": code, "model": model, "android_version": "14", "app_version": "0.1.0"})
    assert r.status_code == 200, r.text
    return r.json()
