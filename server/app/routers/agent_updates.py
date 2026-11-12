"""Agent APK releases. Admins upload; phones fetch with their device token.

Files live in settings.apk_dir with a latest.json describing the current release.
"""

import hashlib
import json
import os
import re
import tempfile
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..deps import require_admin
from ..hub.bus import bus
from ..models import Device, User, utcnow
from ..security import hash_token

router = APIRouter(prefix="/api/agent", tags=["agent updates"])

_NAME = re.compile(r"^agent-\d+\.apk$")


def _dir() -> str:
    d = get_settings().apk_dir
    os.makedirs(d, exist_ok=True)
    return d


def _latest() -> dict | None:
    try:
        with open(os.path.join(_dir(), "latest.json")) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


async def require_device(request: Request, db: AsyncSession = Depends(get_db)) -> Device:
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    device = None
    if token:
        device = await db.scalar(
            select(Device).where(Device.token_hash == hash_token(token), Device.revoked_at.is_(None))
        )
    if device is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unknown device")
    return device


@router.get("/latest")
async def latest_for_device(device: Device = Depends(require_device)):
    rel = _latest()
    if rel is None:
        return Response(status_code=204)
    return {k: rel[k] for k in ("version_code", "version_name", "sha256", "url")}


@router.get("/apk/{name}")
async def download(name: str, device: Device = Depends(require_device)):
    if not _NAME.match(name):
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    path = os.path.join(_dir(), name)
    if not os.path.isfile(path):
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return FileResponse(path, media_type="application/vnd.android.package-archive")


@router.get("/releases/current")
async def current_release(admin: User = Depends(require_admin)):
    return _latest() or {}


@router.post("/releases", status_code=201)
async def upload_release(
    version_code: int = Form(..., ge=1),
    version_name: str = Form(..., min_length=1, max_length=40),
    apk: UploadFile = File(...),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Publishes a new agent APK and tells every online phone to update."""
    current = _latest()
    if current and version_code <= current["version_code"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"version_code must be above {current['version_code']}")
    d = _dir()
    limit = get_settings().max_apk_bytes
    digest = hashlib.sha256()
    size = 0
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".part")
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := await apk.read(1 << 20):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "APK too large")
                digest.update(chunk)
                out.write(chunk)
        with open(tmp, "rb") as f:
            if f.read(4) != b"PK\x03\x04":
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not an APK (zip) file")
        name = f"agent-{version_code}.apk"
        os.replace(tmp, os.path.join(d, name))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    release = {
        "version_code": version_code,
        "version_name": version_name,
        "sha256": digest.hexdigest(),
        "url": f"/api/agent/apk/{name}",
        "size": size,
        "uploaded_at": utcnow().isoformat(),
        "uploaded_by": admin.email,
    }
    tmp_json = os.path.join(d, f".latest-{uuid.uuid4().hex}.json")
    with open(tmp_json, "w") as f:
        json.dump(release, f)
    os.replace(tmp_json, os.path.join(d, "latest.json"))

    audit(db, "agent_release", admin.id, name, {"version_name": version_name, "sha256": release["sha256"]})
    await db.commit()
    # Phones with an operator session postpone the install themselves.
    await bus.to_all_agents({"type": "update_available", "version_code": version_code})
    return release
