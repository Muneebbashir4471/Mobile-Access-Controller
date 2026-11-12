import base64
import hashlib
import hmac
import secrets
import time

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from .config import get_settings

_ph = PasswordHasher()

# No 0/O/1/I so codes can be typed from a screen without mistakes.
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _ph.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


# A real hash to verify against when the email is unknown, so timing does not reveal accounts.
DUMMY_PASSWORD_HASH = _ph.hash(secrets.token_urlsafe(16))


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_pairing_code() -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(8))


def normalize_pairing_code(code: str) -> str:
    return code.strip().upper().replace("-", "").replace(" ", "")


def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name="MT5 Phones")


def verify_totp(secret: str, code: str) -> bool:
    return pyotp.TOTP(secret).verify(code.strip(), valid_window=1)


def turn_credentials(session_id: str) -> dict:
    """coturn use-auth-secret (TURN REST API) credentials, valid for turn_ttl_seconds."""
    s = get_settings()
    expiry = int(time.time()) + s.turn_ttl_seconds
    username = f"{expiry}:{session_id}"
    digest = hmac.new(s.turn_secret.encode(), username.encode(), hashlib.sha1).digest()
    return {
        "urls": s.turn_urls,
        "username": username,
        "credential": base64.b64encode(digest).decode(),
        "ttl": s.turn_ttl_seconds,
    }
