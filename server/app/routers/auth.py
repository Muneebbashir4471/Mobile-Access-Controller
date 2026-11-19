from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..auth_sessions import COOKIE_NAME, create_session, destroy_session
from ..config import get_settings
from ..db import get_db
from ..deps import ADMIN_ROLES, client_ip, current_user, needs_2fa
from ..models import User, utcnow
from ..redis_state import get_redis, k_login_fail, rate_limit
from ..security import DUMMY_PASSWORD_HASH, hash_password, new_totp_secret, totp_uri, verify_password, verify_totp

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Sent with 401 when the password is right but the user has 2FA on and gave no code.
CODE_REQUIRED = "one_time_code_required"


class LoginIn(BaseModel):
    email: str
    password: str
    code: str | None = None


class CodeIn(BaseModel):
    code: str


class DisableIn(BaseModel):
    password: str
    code: str


class PasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12, max_length=200)


def user_out(u: User) -> dict:
    return {"id": str(u.id), "email": u.email, "name": u.name, "role": u.role, "active": u.active, "totp_enabled": u.totp_enabled,
            "must_enable_2fa": needs_2fa(u)}


async def _code_ok(user: User, code: str) -> bool:
    """Checks a one-time code and burns it so it cannot be replayed."""
    code = code.strip()
    if not (user.totp_secret and verify_totp(user.totp_secret, code)):
        return False
    return bool(await get_redis().set(f"totp_used:{user.id}:{code}", "1", nx=True, ex=120))


@router.post("/login")
async def login(body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    s = get_settings()
    r = get_redis()
    ip = client_ip(request)
    email = body.email.strip().lower()

    if not await rate_limit(f"login:{ip}", s.login_rate_per_minute, 60):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts, wait a minute")
    if int(await r.get(k_login_fail(email)) or 0) >= s.login_max_failures:
        raise HTTPException(status.HTTP_423_LOCKED, "Account locked after repeated failures, try again later")

    user = await db.scalar(select(User).where(func.lower(User.email) == email))
    password_ok = verify_password(user.password_hash if user else DUMMY_PASSWORD_HASH, body.password)
    ok = bool(user and user.active and password_ok)

    if ok and user.totp_enabled:
        if not (body.code or "").strip():
            # Right password, code still to come: not a failed attempt.
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, CODE_REQUIRED)
        ok = await _code_ok(user, body.code)

    if not ok:
        fails = await r.incr(k_login_fail(email))
        if fails == 1:
            await r.expire(k_login_fail(email), s.login_lockout_seconds)
        audit(db, "login_failed", user.id if user else None, email, {"ip": ip, "failures": fails})
        if fails == s.login_max_failures:
            audit(db, "account_locked", user.id if user else None, email, {"ip": ip})
        await db.commit()
        detail = "Wrong one-time code" if (user and password_ok and user.totp_enabled) else "Wrong email or password"
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail)

    await r.delete(k_login_fail(email))
    user.last_login_at = utcnow()  # saved with the login audit row below
    token = await create_session(user.id)
    response.set_cookie(
        COOKIE_NAME, token, httponly=True, secure=s.cookie_secure, samesite="strict",
        max_age=s.session_max_seconds, path="/",
    )
    audit(db, "login", user.id, email, {"ip": ip, "two_factor": user.totp_enabled})
    await db.commit()
    return user_out(user)


@router.post("/logout")
async def logout(request: Request, response: Response, user: User = Depends(current_user),
                 db: AsyncSession = Depends(get_db)):
    await destroy_session(request.cookies.get(COOKIE_NAME))
    response.delete_cookie(COOKIE_NAME, path="/")
    audit(db, "logout", user.id, user.email)
    await db.commit()
    return {"ok": True}


@router.get("/me")
async def me(user: User = Depends(current_user)):
    return user_out(user)


# Two-factor setup (Settings page) ---------------------------------------------

def _pending_key(user: User) -> str:
    return f"totp_pending:{user.id}"


@router.post("/2fa/setup")
async def setup_2fa(user: User = Depends(current_user)):
    """Starts setup: a new secret to scan. Nothing changes until /2fa/enable confirms a code."""
    if user.totp_enabled:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Two-factor login is already on")
    secret = new_totp_secret()
    await get_redis().set(_pending_key(user), secret, ex=600)
    return {"secret": secret, "totp_uri": totp_uri(secret, user.email)}


@router.post("/2fa/enable")
async def enable_2fa(body: CodeIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    r = get_redis()
    secret = await r.get(_pending_key(user))
    if not secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Setup expired, start again")
    if not verify_totp(secret, body.code):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That code does not match; check the phone's clock and try the next code")
    await r.delete(_pending_key(user))
    user.totp_secret = secret
    user.totp_enabled = True
    audit(db, "2fa_enabled", user.id, user.email)
    await db.commit()
    return user_out(user)


@router.post("/2fa/disable")
async def disable_2fa(body: DisableIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    if not user.totp_enabled:
        return user_out(user)
    if user.role in ADMIN_ROLES and get_settings().require_admin_2fa:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Admin accounts must keep two-factor login on")
    if not verify_password(user.password_hash, body.password) or not await _code_ok(user, body.code):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Wrong password or code")
    user.totp_enabled = False
    user.totp_secret = None
    audit(db, "2fa_disabled", user.id, user.email)
    await db.commit()
    return user_out(user)


@router.post("/password")
async def change_password(body: PasswordIn, user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """Any signed-in user changes their own password (the current one is required)."""
    if not verify_password(user.password_hash, body.current_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is wrong")
    u = await db.get(User, user.id)
    u.password_hash = hash_password(body.new_password)
    audit(db, "password_changed", u.id, u.email)
    await db.commit()
    return {"ok": True}
