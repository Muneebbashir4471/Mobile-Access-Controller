"""Agent APK hosting for Device Owner QR setup.

Admins upload the agent APK here. A factory-reset phone that scans the Device Owner setup QR
downloads it from the public /api/agent/download/agent.apk link: it has no device token yet, and
the APK is not secret (Android checks its signing certificate against the checksum in the QR).

The agent does not update itself; a new version is installed on each phone by hand. Files live
in settings.apk_dir with a latest.json describing the current upload.
"""

import hashlib
import json
import os
import tempfile
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..deps import require_admin
from ..models import User, utcnow

router = APIRouter(prefix="/api/agent", tags=["agent apk"])

DOWNLOAD_PATH = "/api/agent/download/agent.apk"


def _dir() -> str:
    d = get_settings().apk_dir
    os.makedirs(d, exist_ok=True)
    return d


def latest_release() -> dict | None:
    try:
        with open(os.path.join(_dir(), "latest.json")) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


@router.get("/download/agent.apk")
async def download_latest():
    rel = latest_release()
    if rel is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No agent APK uploaded yet")
    name = rel.get("file") or f"agent-{rel['version_code']}.apk"
    path = os.path.join(_dir(), name)
    if not os.path.isfile(path):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No agent APK uploaded yet")
    return FileResponse(path, media_type="application/vnd.android.package-archive",
                        filename=f"mt5-agent-{rel['version_name']}.apk")


@router.get("/releases/current")
async def current_release(admin: User = Depends(require_admin)):
    return latest_release() or {}


@router.post("/releases", status_code=201)
async def upload_release(
    version_code: int = Form(..., ge=1),
    version_name: str = Form(..., min_length=1, max_length=40),
    apk: UploadFile = File(...),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Stores the agent APK that Device Owner QR setup installs on new phones."""
    current = latest_release()
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
        "file": name,
        "url": DOWNLOAD_PATH,
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
    return release
