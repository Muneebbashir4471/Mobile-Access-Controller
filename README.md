# MT5 Phone Control Platform

Operators open any of the fleet's Android phones in a browser and control it live; trades are
placed by hand in the MT5 app and go to the broker over the phone's own SIM. The full design is
in [docs/MT5-Phone-Control-Platform-Implementation-Spec.pdf](docs/MT5-Phone-Control-Platform-Implementation-Spec.pdf).

| Folder | What |
|---|---|
| `agent-android/` | Kotlin agent app (min Android 10), sideloaded |
| `server/` | FastAPI: REST `api` + WebSocket `hub`, Alembic migrations, tests |
| `dashboard/` | React single-page app |
| `deploy/` | `docker-compose.yml`, `Caddyfile`, `turnserver.conf`, backup script |
| `docs/` | Spec and [runbook](docs/runbook.md) |

## Build status against the spec's milestones

All code for milestones 1–6 is written. Each milestone still needs its check on real phones over
SIM data. [docs/pilot-and-acceptance.md](docs/pilot-and-acceptance.md) has the checks, and the
plan for milestone 0, which is not code.

| # | Milestone | What exists |
|---|---|---|
| 0 | RustDesk pilot | Plan and pass criteria in the doc above, to run on 3 phones |
| 1 | Agent skeleton and hub | Pairing (QR, typed code or adb), encrypted token, foreground service, reconnect 1→60 s, status every 60 s, start on boot; hub presence and live grid |
| 2 | Screen stream | `CaptureManager` (MediaProjection → WebRTC, hardware H.264/VP8, bitrate cap per phone), `RtcSession` (relayed peer connection), consent kept alive; signaling hub and browser control view |
| 3 | Remote input | `InputService` accessibility service: tap, swipe, long press, text, Back/Home/Recents/Enter/Delete; data channel with WebSocket fallback |
| 4 | Users and locking | Argon2 + TOTP, lockout, roles, assignments, 300 s lock, takeover, session and audit logs |
| 5 | Dashboard | Phones grid, control view, account directory and search, admin pages, alerts |
| 6 | Hardening and rollout | Consent after reboot (accessibility auto-accept, `PROJECT_MEDIA` pre-approval, 1 fps screenshot fallback); device-owner policies; self-updater with APK publishing from the dashboard; `deploy/provision-phone.sh`; `server/loadtest/simulate.py` |

**The Android agent has never been compiled.** It was written without an Android SDK. Expect a
round of compile fixes on the first Android Studio build.

## Develop locally

```bash
# Postgres + Redis
docker run -d --name mt5-pg -e POSTGRES_USER=mt5 -e POSTGRES_PASSWORD=mt5 -e POSTGRES_DB=mt5 -p 5432:5432 postgres:16-alpine
docker run -d --name mt5-redis -p 6379:6379 redis:7-alpine

# Server
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env
.venv/bin/alembic upgrade head
.venv/bin/python -m app.cli create-admin you@example.com    # prints the authenticator link
.venv/bin/uvicorn app.main:app --reload --port 8000
.venv/bin/python -m pytest                                  # tests (SQLite + fakeredis)

# Dashboard (proxies /api and /ws to :8000)
cd ../dashboard && npm install && npm run dev               # http://localhost:5173
```

Agent: open `agent-android/` in Android Studio (it creates the Gradle wrapper jar) and build a
**debug** APK. Debug builds allow a plain `http://<your-LAN-IP>:8000` server for testing. Then:

```bash
deploy/provision-phone.sh app-debug.apk http://<LAN-IP>:8000 <PAIRING-CODE>
```

Screen streaming needs a reachable TURN server. Locally, run coturn with `deploy/turnserver.conf`
and set `MT5_TURN_URLS` to your LAN IP.

## Protocol additions beyond the spec

- Operator → server `activity {session_id}`: input travels on the WebRTC data channel, which the
  server cannot see, so the control view sends this (at most every 10 s while the operator is
  using the phone) to refresh the 300 s lock. Reply: `lock_refreshed {expires_in}`.
- Operator → server `input {session_id, event}`: the WebSocket fallback for input events,
  forwarded to the agent unchanged.
- Server → operator `alert`, `device_removed`, `session_ended {reason, by}`.
- Server → agent `update_available`, `input`. Agent status adds `capture_mode`
  (`projection` / `fallback` / `none`).
- Agent APK releases: `POST /api/agent/releases` (admin), `GET /api/agent/latest` and
  `GET /api/agent/apk/{name}` (device token).
- `GET /api/auth/me`, `PATCH|DELETE /api/accounts/{id}`, `PATCH /api/users/{id}`,
  `POST /api/users/{id}/reset-2fa` for the admin pages.
