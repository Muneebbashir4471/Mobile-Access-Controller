# CLAUDE.md — build / run / deploy guide for this project

Context for future Claude Code sessions. This is a custom platform that mirrors and remote-controls
a fleet of ~30 Android phones (built to `docs/MT5-Phone-Control-Platform-Implementation-Spec.pdf`).
Three parts: a **Kotlin/WebRTC Android agent**, a **FastAPI + PostgreSQL + Redis + coturn** server,
and a **React/TypeScript dashboard**. See `PROJECT.md` for the overview and `AGENT.md` for the
Android internals.

## Git / where to commit (read this before committing)

- **Remote (origin):** `git@github.com:Muneebbashir4471/Mobile-Access-Controller.git` (SSH).
- **Default branch:** `main`, which tracks `origin/main`.
- **Workflow:** the owner wants work committed to `main` and pushed directly here — `git push` (not
  feature branches / PRs) unless asked otherwise. Any session or AI agent continuing this project
  should commit and push to **this** repo.
- **Before every push, run a secrets scan.** Never commit or push: `deploy/.env.lan`, `.env`,
  anything under `releases/` (APKs), keystores, or real credentials — all are gitignored; keep it
  that way. Only `*.env.example` templates belong in git.
- Keep the GitHub repo **private** — this is a remote phone-control agent.
- Commit-message attribution: use whatever `Co-Authored-By:` line the current session/harness
  specifies; if none is given, omit it.

## Repository layout

| Path | What it is |
|---|---|
| `agent-android/` | The phone app (Kotlin). Package `com.yourorg.agent`. Built in Docker. |
| `server/` | FastAPI hub (REST + WebSocket). `app/` code, `migrations/` Alembic, `tests/`, `loadtest/`. |
| `dashboard/` | React + TypeScript + Vite. Pages in `src/pages/`. |
| `deploy/` | Docker Compose, Caddy, coturn config, provisioning + backup scripts. |
| `docs/` | Spec PDF, `phone-setup.md`, `runbook.md`, `pilot-and-acceptance.md`. |
| `releases/` | Versioned APKs `mt5-agent-<version>.apk` + `.txt` (sha/version). **gitignored.** |

## Running the server (LAN / local dev)

The LAN stack publishes coturn on explicit ports to get past `ufw`. It reads `deploy/.env.lan`
(gitignored: `LAN_IP`, generated `POSTGRES_PASSWORD`, `TURN_SECRET`).

```bash
cd deploy
# After any IP change, update LAN_IP first:
#   sed -i 's/^LAN_IP=.*/LAN_IP=<new-ip>/' .env.lan
docker compose -f docker-compose.lan.yml --env-file .env.lan up -d --build
curl -s http://<LAN_IP>:8090/api/health            # -> {"ok":true}
docker compose -f docker-compose.lan.yml --env-file .env.lan ps
```

- Dashboard + API are served on **port 8090** (Caddy → web + `/api` → api container).
- The api container runs `alembic upgrade head` on start (see `server/Dockerfile` CMD), so migrations
  are automatic. DB is `postgres:16-alpine`, cache is `redis:7-alpine`, turn is `coturn/coturn:4.6.3`.
- **Finding the current IP:** `ip -4 -o addr show | awk '{print $2,$4}' | grep -v 'lo\|docker\|br-\|veth'`.
  Use the real LAN interface (e.g. `wlp0s20f3`), NOT a VPN interface like `muneeb`/`10.8.0.x`.
- Production compose is `deploy/docker-compose.yml` (host-networked coturn, Caddy TLS). Prefer the
  `.lan.yml` stack for local work.

### First-time admin user

Auth is **session-cookie based** (login returns the user JSON + sets a cookie; there is no bearer
token). 2FA (TOTP) is **optional**, off by default.

```bash
cd deploy
docker compose -f docker-compose.lan.yml --env-file .env.lan exec api \
  python -m app.cli create-admin admin@mt5.local
```

Credentials are secrets — never commit them. The working admin login is held outside the repo.

## Dashboard

React 18 + Vite 5 + TS 5. Built into the `web` container (`deploy/web.Dockerfile`). To rebuild just
the UI after a `dashboard/` change:

```bash
cd deploy && docker compose -f docker-compose.lan.yml --env-file .env.lan up -d --build web
```

The dashboard talks to the API through Caddy with relative `/api` paths, so it does NOT bake in the
LAN IP — only the api container needs `LAN_IP` (for `PUBLIC_URL`, CORS, and TURN URLs handed to clients).

## Tests & load test

```bash
cd server
pytest                                   # 9 tests, spins up Postgres schema itself
python -m loadtest.simulate              # 30 phones / 10 operators; admin TOTP optional
```

## Building the Android agent (release APKs)

Built in Docker (image `mt5-android-build`), never with a local Gradle. Versioned, immutable releases.

1. Bump **both** in `agent-android/app/build.gradle.kts`:
   `versionCode` (must increase) and `versionName`.
2. Build:
   ```bash
   cd agent-android && ./build-apk.sh
   ```
   - Refuses to overwrite an existing `releases/mt5-agent-<name>.apk` or reuse a `versionCode`.
   - Outputs `releases/mt5-agent-<name>.apk` + `.txt` (versionName, versionCode, sha256).
   - Debug-signed with a **stable** keystore in `agent-android/.build-home/.android/debug.keystore`
     — all builds share one signing identity (required for clean OTA updates). Do not delete it.

Version history: 0.3.2 → 0.4.0 → 0.4.1 → 0.5.0 → **0.5.1** (latest, versionCode 9).

## Publishing an update (OTA)

Phones self-update via the agent updater. Publish a built APK to the server, then push a signal.

```bash
cd deploy
JAR=$(mktemp)
curl -s -c "$JAR" -X POST http://<LAN_IP>:8090/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@mt5.local","password":"<PW>"}' >/dev/null
curl -s -b "$JAR" -X POST http://<LAN_IP>:8090/api/agent/releases \
  -F version_code=9 -F version_name=0.5.1 \
  -F apk=@../releases/mt5-agent-0.5.1.apk            # 201 Created
rm -f "$JAR"

# Push "update_available" to one online phone (device id from the DB):
docker compose -f docker-compose.lan.yml --env-file .env.lan exec -T cache \
  redis-cli publish hub:agent:<device_id> '{"type":"update_available","version_code":9}'
```

- The agent checks on start, every 6h, and on the `update_available` push. It will NOT update while
  an operator session is open (`sessions.isNotEmpty()` guard).
- **Known limit:** on a non-device-owner phone the final install needs a user tap, and on Android 12+
  that confirm dialog is suppressed from the background. 0.5.1 adds a tap-to-install **notification**
  so the user can confirm. The app must be in the foreground for the direct dialog to appear.
- Serving an APK over plain HTTP for manual install (no cable):
  `python3 -m http.server 8099 --bind <LAN_IP> --directory releases` → phone browser downloads
  `http://<LAN_IP>:8099/mt5-agent-<v>.apk`.

### Inspect devices / presence (Postgres + Redis)

```bash
cd deploy
docker compose -f docker-compose.lan.yml --env-file .env.lan exec -T db \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "select name, app_version, last_status->>'"'"'capture_mode'"'"', last_seen_at \
   from devices where revoked_at is null order by last_seen_at desc"'
docker compose -f docker-compose.lan.yml --env-file .env.lan exec -T cache redis-cli keys 'presence*'
```

## Phones: provisioning & the capture/killing problem

- **Normal install** (sideload): blocked by Google Play Protect on every brand because the app uses
  Accessibility + screen capture + install-packages + device-admin together (spyware fingerprint).
  Per-phone workaround: Play Store → profile → Play Protect → turn off "Scan apps". No fleet-wide
  software bypass exists; switching launcher/installer does NOT help (Play Protect is in Play Services).
- **`capture_mode: fallback`** = the app lost MediaProjection consent and dropped to ~1 fps screenshots.
  Cause: the app process was killed (OnePlus/OEM battery killer, or an app restart); consent does not
  survive a process restart and cannot be re-granted silently without device owner.
- **Device owner is the real fix** (unkillable + no lock screen + silent updates). Requires a
  **factory-reset phone with NO accounts** (Android rule):
  ```bash
  deploy/provision-phone.sh path/to/mt5-agent-<v>.apk http://<LAN_IP>:8090 <PAIRCODE> [adb-serial]
  # core step: adb shell dpm set-device-owner com.yourorg.agent/.AdminReceiver
  ```
  For a no-cable fleet flow, use **QR device-owner provisioning** (factory reset → tap welcome 6× →
  scan QR). The APK signature checksum for the QR = url-safe base64 of the signing cert SHA-256.

## Conventions / gotchas

- **Never commit** `deploy/.env.lan`, `.env`, APKs, or credentials (see `.gitignore`).
- Git attribution line for commits is provided per-session by the harness — use the one given.
- Don't run an Android build while the KVM emulator is running (OOM). Avoid killing processes with
  `pkill -f` / `pgrep -f` (matches this shell); kill by PID.
- Stable tag `stable-0.4.0` marks a known-good baseline.
