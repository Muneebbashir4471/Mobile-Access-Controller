# PROJECT.md — MT5 Phone Control Platform

A self-hosted platform to **mirror and remote-control a fleet of ~30 Android phones** from a web
dashboard, built to `docs/MT5-Phone-Control-Platform-Implementation-Spec.pdf`. Operators open a phone
in the browser, see its live screen, and tap/type/scroll as if holding it — for running MT5 trading
apps on many phones from one place.

It is a **custom build** on standard primitives (WebRTC, MediaProjection, AccessibilityService) — not
a rebrand of RustDesk/scrcpy/AnyDesk.

## The three components

```
   ┌─────────────────┐        WebSocket (signaling, input)      ┌──────────────────┐
   │  Android agent   │  ◄──────────────────────────────────►   │     Server       │
   │ (Kotlin/WebRTC)  │                                          │   (FastAPI hub)  │
   │  on each phone   │  ──────  WebRTC video (direct/TURN) ───► │  Postgres/Redis  │
   └─────────────────┘                                          │     coturn       │
                                                                 └────────┬─────────┘
                                                                          │ REST + WS
                                                                 ┌────────▼─────────┐
                                                                 │   Dashboard      │
                                                                 │ (React/TS/Vite)  │
                                                                 │   operators      │
                                                                 └──────────────────┘
```

1. **Android agent** (`agent-android/`) — Kotlin foreground service. Captures the screen via
   MediaProjection (WebRTC video), accepts input via AccessibilityService, self-updates, and can run
   as device owner. Details in **`AGENT.md`**.

2. **Server / hub** (`server/`) — FastAPI (async). REST API + a WebSocket **hub** that relays
   signaling/input between operators and agents. PostgreSQL (SQLAlchemy 2 async + Alembic) for
   devices/users/accounts/assignments/audit; Redis for presence, device locks, auth sessions, and a
   cross-worker pub/sub bus; coturn for WebRTC TURN relay. Argon2 passwords; optional TOTP 2FA.

3. **Dashboard** (`dashboard/`) — React 18 + TypeScript + Vite. Pages: `Login`, `Phones` (fleet),
   `Control` (live view + input + stats), `Devices` (pairing + releases), `Accounts`, `Assignments`
   via `Users`, `History`, `Settings` (2FA).

All wired together with **Docker Compose** + Caddy (`deploy/`).

## How a session works

1. A phone is **paired** (dashboard issues a code → agent scans QR / enters code → gets a device token).
2. The agent connects to the hub over WebSocket and reports status (online, `capture_mode`, battery,
   carrier, screen/lock state).
3. An operator opens the phone → hub creates a session (one viewer per phone; Redis lock).
4. **WebRTC** is negotiated through the hub (browser offers, agent answers); video flows direct on LAN
   or via TURN over the internet.
5. Input events flow back over a WebRTC data channel (WebSocket fallback). The agent executes them via
   AccessibilityService. The agent streams `rtc_stats` for latency diagnostics.

## Status

- Server + dashboard: implemented and tested (`pytest` 9 passing; load test 30 phones/10 operators).
- Android agent: implemented (capture/input/updater/device-owner/wake-unlock-lock); latest release
  **0.5.1** (versionCode 9).
- Runs on the LAN stack; real-world use is on dedicated phones. The main operational challenge is
  keeping phones in live `projection` capture — solved properly only by **device owner** provisioning
  (see `AGENT.md` and `CLAUDE.md`). Milestone/acceptance status: `docs/pilot-and-acceptance.md`.

## Tech at a glance

| Layer | Stack |
|---|---|
| Phone app | Kotlin, WebRTC (`stream-webrtc-android` / `org.webrtc`), MediaProjection, AccessibilityService, DevicePolicyManager, OkHttp, CameraX + ML Kit |
| Server | FastAPI, Uvicorn, SQLAlchemy 2 (async) + asyncpg, Alembic, Redis, Argon2, pyotp, coturn |
| Dashboard | React 18, TypeScript 5, Vite 5, react-router 6 |
| Infra | Docker Compose, Caddy, PostgreSQL 16, Redis 7, coturn 4.6.3 |

## Git / repository

Code lives on GitHub at **`git@github.com:Muneebbashir4471/Mobile-Access-Controller.git`** (private),
branch **`main`**. Commit and push work directly to `origin/main` here. Never commit secrets
(`deploy/.env.lan`, `.env`, `releases/*.apk`, keystores) — they are gitignored. See `CLAUDE.md` →
"Git / where to commit" for the full workflow.

## Where to look

- Build / run / deploy / release / provisioning commands → **`CLAUDE.md`**
- Git remote & commit workflow → **`CLAUDE.md`** → "Git / where to commit"
- Android agent internals (capture modes, WebRTC, device owner) → **`AGENT.md`**
- Per-phone setup checklist → `docs/phone-setup.md`
- Ops runbook → `docs/runbook.md`
- Acceptance criteria → `docs/pilot-and-acceptance.md`
- Original spec → `docs/MT5-Phone-Control-Platform-Implementation-Spec.pdf`
