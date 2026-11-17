"""Bootstrap commands.

  python -m app.cli create-admin admin@example.com
  python -m app.cli create-superuser owner@example.com
"""

import argparse
import asyncio
import getpass

from sqlalchemy import func, select

from .config import get_settings
from .db import dispose_engine, init_engine, session_factory
from .models import User
from .security import hash_password


async def create_privileged(email: str, password: str, role: str) -> None:
    init_engine(get_settings().database_url)
    try:
        async with session_factory()() as db:
            email = email.strip().lower()
            if await db.scalar(select(User).where(func.lower(User.email) == email)):
                raise SystemExit(f"{email} already exists")
            db.add(User(email=email, password_hash=hash_password(password), role=role, totp_enabled=False))
            await db.commit()
        print(f"Created {role} {email}. Turn on two-factor login from the dashboard's Settings page.")
    finally:
        await dispose_engine()


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    for cmd in ("create-admin", "create-superuser"):
        sub.add_parser(cmd).add_argument("email")
    args = p.parse_args()
    if args.cmd in ("create-admin", "create-superuser"):
        pw = getpass.getpass("Password (12+ characters): ")
        if len(pw) < 12 or pw != getpass.getpass("Again: "):
            raise SystemExit("Passwords must match and be at least 12 characters")
        role = "superuser" if args.cmd == "create-superuser" else "admin"
        asyncio.run(create_privileged(args.email, pw, role))


if __name__ == "__main__":
    main()
